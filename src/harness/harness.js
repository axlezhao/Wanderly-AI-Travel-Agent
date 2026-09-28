// The ReAct harness: runs Thought -> Action -> Observation until the policy
// produces a Final Answer.
//
// The harness owns everything around the model so any "brain" (Claude, the
// rule-based demo planner, a scripted test policy) gets the same guarantees:
//   - a hard step limit, with one last forced-answer step instead of a dead end
//   - model retries: a model request that fails for a temporary reason (rate
//     limit, overload, network drop) is re-sent with backoff, for every provider
//   - parallel actions within a step
//   - per-tool timeouts; every failed lookup is tried a second time
//     (transient errors like 429/5xx/timeouts up to maxRetries more times)
//   - LLM fallback: when a lookup still fails, the observation tells the model
//     to fill that gap from its own knowledge, labeled as such
//   - a circuit breaker: a tool that keeps failing is skipped for the rest of
//     the run instead of burning time on it
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
import { classifyModelError } from "./model-errors.js";

export const DEFAULTS = {
  maxSteps: 6,
  toolTimeoutMs: 60000,
  maxRetries: 2,
  retryBaseDelayMs: 600,
  maxObservationChars: 12000,
  // After this many failed calls to the same tool in one run, skip it.
  circuitBreakAfter: 2,
  // Model requests: retries for temporary failures, exponential backoff, and a cap on
  // how long to wait (a provider's Retry-After header is honored up to the cap).
  modelRetries: 2,
  modelRetryBaseDelayMs: 1000,
  modelRetryMaxDelayMs: 20000,
};

// Retrying the identical call can't fix bad arguments; the model has to change them.
const INVALID_INPUT = /input validation error|validating "arguments"|invalid arguments/i;

const FALLBACK_HINT =
  "\n\n[Harness] This lookup failed even after a retry. Don't call it again. " +
  "Fill this part from your own general knowledge, and label it briefly as general knowledge (not live data).";

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
    const stats = { steps: 0, toolCalls: 0, toolErrors: 0, cacheHits: 0, retries: 0, fallbacks: 0, modelRetries: 0 };
    const failures = new Map(); // tool name -> failed calls this run (circuit breaker)

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

        const decision = await this.#decide(policy, {
          step,
          maxSteps,
          forceAnswer,
          signal,
          // Policies may stream text while they think; we don't yet know if it's a Thought or the Answer.
          emit: (e) => emit({ ...e, step }),
        }, stats);

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
          actions.map((action) => this.#act(action, { step, emit, signal, cache, stats, failures })),
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

  // Ask the policy for its next move, re-sending the model request if it fails for a
  // temporary reason. Policies only record a model reply once it arrives complete,
  // so a retry sends exactly the same conversation again.
  async #decide(policy, args, stats) {
    const { modelRetries, modelRetryBaseDelayMs, modelRetryMaxDelayMs } = this.options;
    for (let attempt = 1; ; attempt++) {
      try {
        return await policy.decide(args);
      } catch (err) {
        if (args.signal?.aborted) throw err;
        const { retryable, retryAfterMs, reason } = classifyModelError(err);
        if (!retryable || attempt > modelRetries) throw err;
        const waitMs = Math.min(retryAfterMs ?? modelRetryBaseDelayMs * 2 ** (attempt - 1), modelRetryMaxDelayMs);
        stats.modelRetries++;
        args.emit({ type: "draft_reset" }); // discard any half-streamed text
        args.emit({ type: "model_retry", attempt: attempt + 1, maxAttempts: modelRetries + 1, reason, waitMs });
        await sleep(waitMs, args.signal);
      }
    }
  }

  // Execute one Action and turn the outcome into an Observation.
  async #act(action, { step, emit, signal, cache, stats, failures }) {
    const { id, tool, input } = action;
    const { toolTimeoutMs, maxRetries, retryBaseDelayMs, maxObservationChars, circuitBreakAfter } = this.options;
    emit({ type: "action", step, id, tool, input, label: describeAction(tool, input) });
    stats.toolCalls++;

    const key = `${tool}:${stableStringify(input)}`;
    const started = Date.now();
    let outcome, attempts = 0, cached = false, skipped = false;

    if (cache.has(key)) {
      outcome = cache.get(key);
      cached = true;
      stats.cacheHits++;
    } else if ((failures.get(tool) ?? 0) >= circuitBreakAfter) {
      // This tool keeps failing this run: don't wait on it again.
      skipped = true;
      outcome = { text: `Error: ${tool} is unavailable right now (it failed repeatedly), so it was skipped.`, ui: null, isError: true, retryable: false };
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
        if (!outcome.isError) break;
        // Transient errors get up to maxRetries more tries; any other failure gets one second try,
        // except bad input, which only the model can fix.
        const retriesAllowed = outcome.retryable ? maxRetries : INVALID_INPUT.test(outcome.text) ? 0 : 1;
        if (attempts > retriesAllowed) break;
        stats.retries++;
        emit({ type: "retry", step, id, tool, attempt: attempts + 1, reason: outcome.text });
        await sleep(retryBaseDelayMs * 2 ** (attempts - 1), signal);
      }
      if (!outcome.isError) cache.set(key, outcome);
    }
    let content = truncate(outcome.text, maxObservationChars);
    let fallback = false;
    if (outcome.isError) {
      stats.toolErrors++;
      failures.set(tool, (failures.get(tool) ?? 0) + 1);
      // Out of retries: hand this part over to the model's own knowledge.
      if (!INVALID_INPUT.test(outcome.text)) {
        fallback = true;
        stats.fallbacks++;
        content += FALLBACK_HINT;
      }
    }
    emit({
      type: "observation",
      step,
      id,
      tool,
      ok: !outcome.isError,
      summary: summarizeObservation(tool, outcome),
      ui: outcome.ui,
      cached,
      skipped,
      fallback,
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
