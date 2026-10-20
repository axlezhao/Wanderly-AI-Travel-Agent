// The two halves of one ReAct step, shared by both harnesses (the hand-written
// loop in harness.js and the LangGraph graph in langgraph-harness.js):
//   decideWithRetries  ask the policy for its next move, re-sending a model
//                      request that failed for a temporary reason
//   runAction          execute one Action and turn the outcome into an Observation
//                      (timeouts, retries, circuit breaker, cache, truncation, fallback)
//
// Keeping these in one place means the harnesses only differ in how they
// orchestrate steps, so comparing them compares orchestration alone.

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

const FALLBACK_HINT =
  "\n\n[Harness] This lookup failed even after a retry. Don't call it again. " +
  "Fill this part from your own general knowledge, and label it briefly as general knowledge (not live data).";

export class StepLimitError extends Error {}

export function newStats() {
  return { steps: 0, toolCalls: 0, toolErrors: 0, cacheHits: 0, retries: 0, fallbacks: 0, modelRetries: 0 };
}

// Ask the policy for its next move, re-sending the model request if it fails for a
// temporary reason. Policies only record a model reply once it arrives complete,
// so a retry sends exactly the same conversation again.
export async function decideWithRetries(policy, args, { stats, options }) {
  const { modelRetries, modelRetryBaseDelayMs, modelRetryMaxDelayMs } = options;
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
export async function runAction(action, { toolbox, options, step, emit, signal, cache, stats, failures }) {
  const { id, tool, input } = action;
  const { toolTimeoutMs, maxRetries, retryBaseDelayMs, maxObservationChars, circuitBreakAfter } = options;
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
    outcome = { text: `Error: ${tool} is unavailable right now (it failed repeatedly), so it was skipped.`, ui: null, isError: true, retry: "never" };
  } else {
    while (true) {
      attempts++;
      try {
        outcome = await toolbox.callTool(tool, input, { signal, timeoutMs: toolTimeoutMs });
      } catch (err) {
        throwIfAborted(signal);
        // Transport-level failure (timeout, server crash): treat as transient.
        outcome = { text: `Error: ${err.message}`, ui: null, isError: true, retry: "transient" };
      }
      if (!outcome.isError) break;
      // The tool says how to retry: transient failures get up to maxRetries more tries,
      // unexpected ones a second try, and "never" (nothing found, bad input, the tool
      // already retried) none. A toolbox that doesn't say gets the cautious middle.
      const retry = outcome.retry ?? "once";
      const retriesAllowed = retry === "transient" ? maxRetries : retry === "once" ? 1 : 0;
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
    // Out of retries: hand this part over to the model's own knowledge,
    // unless the model just needs to fix its arguments.
    if (!outcome.invalidInput) {
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

export function throwIfAborted(signal) {
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
