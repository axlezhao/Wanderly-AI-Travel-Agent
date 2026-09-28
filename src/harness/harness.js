// The ReAct harness: runs Thought -> Action -> Observation until the policy
// produces a Final Answer.
//
// The harness owns everything around the model so any "brain" (Claude, the
// rule-based demo planner, a scripted test policy) gets the same guarantees:
//   - a hard step limit, with one last forced-answer step instead of a dead end
//   - parallel actions within a step
//   - per-tool timeouts and retries with backoff for transient failures
//   - a per-session cache so repeated identical calls don't hit the APIs again
//   - observation truncation so one huge result can't flood the context
//   - cancellation (client disconnects -> in-flight work stops)
//   - a structured event stream for the UI and a JSONL trace for debugging
//
// A policy implements:
//   decide({ step, maxSteps, forceAnswer, emit, signal })
//     -> { thought, actions: [{ id, tool, input }] }   take actions
//     -> { thought?, answer }                          finish
//   observe(observations: [{ id, tool, content, isError }])
//   usage?  optional { input_tokens, output_tokens, ... } running totals

import { describeAction, summarizeObservation } from "./labels.js";

export const DEFAULTS = {
  maxSteps: 8,
  toolTimeoutMs: 60000,
  maxRetries: 2,
  retryBaseDelayMs: 600,
  maxObservationChars: 12000,
};

export class StepLimitError extends Error {}

export class ReActHarness {
  constructor({ toolbox, tracer = null, ...options }) {
    this.toolbox = toolbox;
    this.tracer = tracer;
    this.options = { ...DEFAULTS, ...options };
  }

  /**
   * Run one user request to completion.
   * @param {object} p
   * @param {object} p.policy      the "brain" deciding thoughts/actions/answer
   * @param {string} p.runId
   * @param {(event) => void} p.onEvent  receives every harness event
   * @param {AbortSignal} [p.signal]
   * @param {Map} [p.cache]        session-scoped tool-result cache
   */
  async run({ policy, runId, onEvent = () => {}, signal, cache = new Map(), meta = {} }) {
    const { maxSteps } = this.options;
    const startedAt = Date.now();
    const trace = this.tracer?.start(runId, { policy: policy.name, ...meta });
    const stats = { steps: 0, toolCalls: 0, toolErrors: 0, cacheHits: 0, retries: 0 };

    const emit = (event) => {
      const e = { ...event, runId, t: Date.now() - startedAt };
      trace?.log(e);
      onEvent(e);
    };

    emit({ type: "run_start", policy: policy.name, maxSteps });
    let answer = null;
    let status = "ok";

    try {
      for (let step = 1; step <= maxSteps; step++) {
        throwIfAborted(signal);
        stats.steps = step;
        const forceAnswer = step === maxSteps;
        emit({ type: "step_start", step, forceAnswer });

        const decision = await policy.decide({
          step,
          maxSteps,
          forceAnswer,
          signal,
          // Policies may stream text while they think; we don't yet know if it's a Thought or the Answer.
          emit: (e) => emit({ ...e, step }),
        });

        if (decision.answer !== undefined) {
          if (decision.thought) emit({ type: "thought", step, text: decision.thought });
          answer = decision.answer;
          break;
        }

        const actions = decision.actions ?? [];
        emit({ type: "thought", step, text: decision.thought ?? "" });
        if (forceAnswer && actions.length) throw new StepLimitError(`Stopped after ${maxSteps} steps without a final answer.`);
        if (actions.length === 0) continue; // e.g. the model paused mid-turn; just ask it again

        const observations = await Promise.all(
          actions.map((action) => this.#act(action, { step, emit, signal, cache, stats })),
        );
        policy.observe(observations);
      }
      if (answer === null) throw new StepLimitError(`Stopped after ${maxSteps} steps without a final answer.`);
      emit({ type: "answer", text: answer });
    } catch (err) {
      status = signal?.aborted ? "cancelled" : "error";
      emit({ type: "error", message: status === "cancelled" ? "Cancelled." : err.message });
    } finally {
      const summary = { status, ...stats, durationMs: Date.now() - startedAt, usage: policy.usage ?? null };
      emit({ type: "run_end", ...summary });
      trace?.end(summary);
    }
    return { answer, status };
  }

  // Execute one Action and turn the outcome into an Observation.
  async #act(action, { step, emit, signal, cache, stats }) {
    const { id, tool, input } = action;
    const { toolTimeoutMs, maxRetries, retryBaseDelayMs, maxObservationChars } = this.options;
    emit({ type: "action", step, id, tool, input, label: describeAction(tool, input) });
    stats.toolCalls++;

    const key = `${tool}:${stableStringify(input)}`;
    const started = Date.now();
    let outcome, attempts = 0, cached = false;

    if (cache.has(key)) {
      outcome = cache.get(key);
      cached = true;
      stats.cacheHits++;
    } else {
      while (true) {
        attempts++;
        try {
          outcome = await this.toolbox.callTool(tool, input, { signal, timeoutMs: toolTimeoutMs });
        } catch (err) {
          throwIfAborted(signal);
          // Transport-level failure (timeout, server crash): treat as transient.
          outcome = { text: `Error: ${err.message}`, ui: null, isError: true, retryable: true };
        }
        if (!(outcome.isError && outcome.retryable) || attempts > maxRetries) break;
        stats.retries++;
        emit({ type: "retry", step, id, tool, attempt: attempts + 1, reason: outcome.text });
        await sleep(retryBaseDelayMs * 2 ** (attempts - 1), signal);
      }
      if (!outcome.isError) cache.set(key, outcome);
    }
    if (outcome.isError) stats.toolErrors++;

    const content = truncate(outcome.text, maxObservationChars);
    emit({
      type: "observation",
      step,
      id,
      tool,
      ok: !outcome.isError,
      summary: summarizeObservation(tool, outcome),
      ui: outcome.ui,
      cached,
      attempts,
      durationMs: Date.now() - started,
      chars: outcome.text.length,
    });
    return { id, tool, input, content, isError: outcome.isError, ui: outcome.ui };
  }
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} characters]`;
}

// Key order shouldn't matter for caching: {a,b} and {b,a} are the same call.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("Cancelled.");
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Cancelled."));
    }, { once: true });
  });
}
