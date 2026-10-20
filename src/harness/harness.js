// The ReAct harness: runs Thought -> Action -> Observation until the policy
// produces a Final Answer.
//
// The harness owns everything around the model so any "brain" (Claude, the
// rule-based demo planner, a scripted test policy) gets the same guarantees:
//   - a hard step limit, with one last forced-answer step instead of a dead end
//   - model retries: a model request that fails for a temporary reason (rate
//     limit, overload, network drop) is re-sent with backoff, for every provider
//   - parallel actions within a step
//   - per-tool timeouts; failed lookups are retried the way the tool asks
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
// The per-step mechanics live in steps.js, shared with the LangGraph version
// of this loop (langgraph-harness.js).
//
// A policy implements:
//   decide({ step, maxSteps, forceAnswer, emit, signal })
//     -> { thought, actions: [{ id, tool, input }] }   take actions
//     -> { thought?, answer }                          finish
//   observe(observations: [{ id, tool, content, isError }])
//   usage?  optional { input_tokens, output_tokens, ... } running totals

import { DEFAULTS, StepLimitError, decideWithRetries, newStats, runAction, throwIfAborted } from "./steps.js";

export { DEFAULTS, StepLimitError };

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
    const stats = newStats();
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

        const decision = await decideWithRetries(policy, {
          step,
          maxSteps,
          forceAnswer,
          signal,
          // Policies may stream text while they think; we don't yet know if it's a Thought or the Answer.
          emit: (e) => emit({ ...e, step }),
        }, { stats, options: this.options });

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
          actions.map((action) => runAction(action, { toolbox: this.toolbox, options: this.options, step, emit, signal, cache, stats, failures })),
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
}
