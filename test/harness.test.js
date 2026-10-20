// Offline tests for the ReAct harness: a fake toolbox and scripted policies,
// so every guarantee (step limit, retries, cache, truncation, cancellation) is
// checked deterministically without touching the network or an LLM.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ReActHarness } from "../src/harness/harness.js";
import { LangGraphHarness } from "../src/harness/langgraph-harness.js";

// A policy that follows a fixed script of decisions and records what it saw.
function scripted(decisions) {
  const seen = { observations: [], forceAnswerAt: null };
  let i = 0;
  return {
    name: "scripted",
    seen,
    async decide({ step, forceAnswer }) {
      if (forceAnswer) seen.forceAnswerAt = step;
      const d = decisions[Math.min(i++, decisions.length - 1)];
      return typeof d === "function" ? d(seen) : d;
    },
    observe(obs) {
      seen.observations.push(...obs);
    },
  };
}

// A toolbox whose behavior per tool is a function (input, callCount) -> outcome.
function fakeToolbox(behaviors) {
  const calls = [];
  return {
    calls,
    async callTool(name, input, { signal } = {}) {
      calls.push({ name, input });
      const n = calls.filter((c) => c.name === name).length;
      return behaviors[name](input, n, signal);
    },
  };
}

const ok = (text) => ({ text, ui: null, isError: false });
const fail = (text, retry, extra = {}) => ({ text, ui: null, isError: true, retry, ...extra });
const act = (...tools) => ({ thought: "need data", actions: tools.map((t, i) => ({ id: `${t}_${i}`, tool: t, input: { q: t } })) });

async function run(harness, policy, extra = {}) {
  const events = [];
  const result = await harness.run({ policy, runId: "test", onEvent: (e) => events.push(e), ...extra });
  return { ...result, events, end: events.find((e) => e.type === "run_end") };
}

// Every test runs against both harnesses: they must behave the same.
for (const [label, Harness] of [["ReAct loop", ReActHarness], ["LangGraph", LangGraphHarness]]) {
  describe(label, () => {
    test("runs Thought -> Action -> Observation -> Answer, with actions in parallel", async () => {
      let inFlight = 0, maxInFlight = 0;
      const slow = async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return ok("{}");
      };
      const harness = new Harness({ toolbox: fakeToolbox({ a: slow, b: slow }) });
      const policy = scripted([act("a", "b"), { answer: "Here is your trip." }]);
      const { answer, status, events, end } = await run(harness, policy);

      assert.equal(status, "ok");
      assert.equal(answer, "Here is your trip.");
      assert.equal(maxInFlight, 2, "both actions of one step run concurrently");
      assert.deepEqual(
        events.map((e) => e.type).filter((t) => t !== "step_start"),
        ["run_start", "thought", "action", "action", "observation", "observation", "answer", "run_end"],
      );
      assert.equal(policy.seen.observations.length, 2);
      assert.equal(end.steps, 2);
      assert.equal(end.toolCalls, 2);
    });

    test("hands observations back in Action order, whichever tool finishes first", async () => {
      const after = (ms) => async () => (await new Promise((r) => setTimeout(r, ms)), ok("{}"));
      const harness = new Harness({ toolbox: fakeToolbox({ slow: after(30), fast: after(1) }) });
      const policy = scripted([act("slow", "fast"), { answer: "done" }]);
      await run(harness, policy);
      assert.deepEqual(policy.seen.observations.map((o) => o.tool), ["slow", "fast"]);
    });

    test("enforces the step limit and gives the policy a final forced-answer step", async () => {
      const harness = new Harness({ toolbox: fakeToolbox({ a: async () => ok("{}") }), maxSteps: 3 });
      const policy = scripted([act("a")]); // never answers
      const { status, events } = await run(harness, policy);

      assert.equal(status, "error");
      assert.equal(policy.seen.forceAnswerAt, 3);
      assert.match(events.find((e) => e.type === "error").message, /Stopped after 3 steps/);
    });

    test("a policy that answers on the forced step finishes normally", async () => {
      const harness = new Harness({ toolbox: fakeToolbox({ a: async () => ok("{}") }), maxSteps: 2 });
      const policy = scripted([act("a"), { answer: "best effort" }]);
      const { status, answer } = await run(harness, policy);
      assert.equal(status, "ok");
      assert.equal(answer, "best effort");
    });

    test("retries transient failures with backoff, then succeeds", async () => {
      const toolbox = fakeToolbox({
        a: async (_input, n) => (n < 3 ? fail("Error: 503", "transient") : ok('{"fine":true}')),
      });
      const harness = new Harness({ toolbox, retryBaseDelayMs: 1 });
      const policy = scripted([act("a"), { answer: "done" }]);
      const { events, end } = await run(harness, policy);

      const obs = events.find((e) => e.type === "observation");
      assert.equal(obs.ok, true);
      assert.equal(obs.attempts, 3);
      assert.equal(end.retries, 2);
      assert.equal(events.filter((e) => e.type === "retry").length, 2);
    });

    test("tries a failed lookup a second time, then hands the gap to the model's own knowledge", async () => {
      const toolbox = fakeToolbox({ a: async () => fail("Error: something odd", "once") });
      const harness = new Harness({ toolbox, retryBaseDelayMs: 1 });
      const policy = scripted([act("a"), { answer: "sorry" }]);
      const { end, events } = await run(harness, policy);

      assert.equal(toolbox.calls.length, 2, "one retry for a non-transient failure");
      const obs = policy.seen.observations[0];
      assert.equal(obs.isError, true);
      assert.match(obs.content, /something odd/);
      assert.match(obs.content, /general knowledge/, "the model is told to fall back on its own knowledge");
      assert.equal(events.find((e) => e.type === "observation").fallback, true);
      assert.equal(end.toolErrors, 1);
      assert.equal(end.fallbacks, 1);
    });

    test("a second try that succeeds is a normal observation", async () => {
      const toolbox = fakeToolbox({
        a: async (_i, n) => (n === 1 ? fail("Error: hiccup", "once") : ok('{"ok":1}')),
      });
      const harness = new Harness({ toolbox, retryBaseDelayMs: 1 });
      const policy = scripted([act("a"), { answer: "done" }]);
      const { end } = await run(harness, policy);
      assert.equal(policy.seen.observations[0].isError, false);
      assert.equal(end.fallbacks, 0);
    });

    test("does not retry invalid input: only the model can fix its arguments", async () => {
      // No error-text matching: the toolbox's invalidInput flag is what counts.
      const toolbox = fakeToolbox({ a: async () => fail("Error: latitude must be a number", "never", { invalidInput: true }) });
      const harness = new Harness({ toolbox, retryBaseDelayMs: 1 });
      const policy = scripted([act("a"), { answer: "ok" }]);
      await run(harness, policy);
      assert.equal(toolbox.calls.length, 1);
      assert.doesNotMatch(policy.seen.observations[0].content, /general knowledge/);
    });

    test('retry "never": no second try, but the model still falls back on its own knowledge', async () => {
      // e.g. Overpass, which already tried both of its servers before giving up
      const toolbox = fakeToolbox({ a: async () => fail("Error: OpenStreetMap (Overpass) is overloaded right now.", "never") });
      const harness = new Harness({ toolbox, retryBaseDelayMs: 1 });
      const policy = scripted([act("a"), { answer: "ok" }]);
      const { events } = await run(harness, policy);
      assert.equal(toolbox.calls.length, 1);
      assert.equal(events.filter((e) => e.type === "retry").length, 0);
      assert.match(policy.seen.observations[0].content, /general knowledge/);
    });

    test("a toolbox that doesn't say how to retry gets one second try", async () => {
      const toolbox = fakeToolbox({ a: async () => ({ text: "Error: ?", ui: null, isError: true }) });
      const harness = new Harness({ toolbox, retryBaseDelayMs: 1 });
      await run(harness, scripted([act("a"), { answer: "ok" }]));
      assert.equal(toolbox.calls.length, 2);
    });

    test("circuit breaker: a tool that keeps failing is skipped for the rest of the run", async () => {
      const toolbox = fakeToolbox({ a: async () => fail("Error: overloaded", "once") });
      const harness = new Harness({ toolbox, retryBaseDelayMs: 1 });
      const call = (q) => ({ thought: "", actions: [{ id: q, tool: "a", input: { q } }] });
      const policy = scripted([call("1"), call("2"), call("3"), { answer: "done" }]);
      const { events } = await run(harness, policy);

      assert.equal(toolbox.calls.length, 4, "two failed calls (each tried twice), then no more");
      const third = events.filter((e) => e.type === "observation")[2];
      assert.equal(third.skipped, true);
      assert.match(policy.seen.observations[2].content, /skipped/);
    });

    test("treats thrown transport errors (e.g. MCP timeouts) as retryable", async () => {
      const toolbox = fakeToolbox({
        a: async (_i, n) => {
          if (n === 1) throw new Error("MCP error -32001: Request timed out");
          return ok("{}");
        },
      });
      const harness = new Harness({ toolbox, retryBaseDelayMs: 1 });
      const { events } = await run(harness, scripted([act("a"), { answer: "ok" }]));
      assert.equal(events.find((e) => e.type === "observation").attempts, 2);
    });

    test("caches identical calls within a session (key order doesn't matter)", async () => {
      const toolbox = fakeToolbox({ a: async () => ok("{}") });
      const harness = new Harness({ toolbox });
      const cache = new Map();
      const call = (input) => ({ thought: "", actions: [{ id: "x", tool: "a", input }] });

      await run(harness, scripted([call({ lat: 1, lon: 2 }), { answer: "1" }]), { cache });
      const second = await run(harness, scripted([call({ lon: 2, lat: 1 }), { answer: "2" }]), { cache });

      assert.equal(toolbox.calls.length, 1);
      assert.equal(second.events.find((e) => e.type === "observation").cached, true);
      assert.equal(second.end.cacheHits, 1);
    });

    test("never caches errors", async () => {
      const toolbox = fakeToolbox({ a: async () => fail("Error: x", "once") });
      const harness = new Harness({ toolbox, retryBaseDelayMs: 1 });
      const cache = new Map();
      await run(harness, scripted([act("a"), { answer: "1" }]), { cache });
      await run(harness, scripted([act("a"), { answer: "2" }]), { cache });
      assert.equal(toolbox.calls.length, 4, "each run tries twice; the failure is not served from cache");
    });

    test("truncates huge observations before they reach the model", async () => {
      const toolbox = fakeToolbox({ a: async () => ok("x".repeat(5000)) });
      const harness = new Harness({ toolbox, maxObservationChars: 100 });
      const policy = scripted([act("a"), { answer: "ok" }]);
      await run(harness, policy);
      const content = policy.seen.observations[0].content;
      assert.ok(content.length < 200);
      assert.match(content, /truncated 4900 characters/);
    });

    test("cancellation stops the run and reports it", async () => {
      const controller = new AbortController();
      const toolbox = fakeToolbox({
        a: (_i, _n, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
            setTimeout(() => controller.abort(), 10);
          }),
      });
      const harness = new Harness({ toolbox });
      const { status, events } = await run(harness, scripted([act("a"), { answer: "never" }]), { signal: controller.signal });
      assert.equal(status, "cancelled");
      assert.equal(events.at(-1).type, "run_end");
      assert.equal(events.at(-1).status, "cancelled");
    });

    test("a policy exception becomes an error event, not a crash", async () => {
      const harness = new Harness({ toolbox: fakeToolbox({}) });
      const policy = { name: "broken", decide: async () => { throw new Error("model API down"); }, observe() {} };
      const { status, events } = await run(harness, policy);
      assert.equal(status, "error");
      assert.equal(events.find((e) => e.type === "error").message, "model API down");
    });

    // ---- model request retries (all providers) ----

    const flaky = (failures, error) => {
      let calls = 0;
      return {
        name: "flaky",
        get calls() { return calls; },
        async decide() {
          calls++;
          if (calls <= failures) throw error();
          return { answer: "made it" };
        },
        observe() {},
      };
    };

    test("re-sends a model request that failed for a temporary reason", async () => {
      const harness = new Harness({ toolbox: fakeToolbox({}), modelRetryBaseDelayMs: 1 });
      const policy = flaky(2, () => Object.assign(new Error("Overloaded"), { status: 529 }));
      const { status, answer, events, end } = await run(harness, policy);

      assert.equal(status, "ok");
      assert.equal(answer, "made it");
      assert.equal(policy.calls, 3);
      assert.equal(end.modelRetries, 2);
      const retries = events.filter((e) => e.type === "model_retry");
      assert.deepEqual(retries.map((e) => e.attempt), [2, 3]);
      assert.match(retries[0].reason, /529 overloaded/);
      assert.ok(events.some((e) => e.type === "draft_reset"), "half-streamed text is discarded before retrying");
    });

    test("gives up after the retry budget", async () => {
      const harness = new Harness({ toolbox: fakeToolbox({}), modelRetryBaseDelayMs: 1, modelRetries: 2 });
      const policy = flaky(99, () => Object.assign(new Error("rate limited"), { status: 429 }));
      const { status } = await run(harness, policy);
      assert.equal(status, "error");
      assert.equal(policy.calls, 3, "1 try + 2 retries");
    });

    test("does not retry errors that can't succeed (bad key, bad request)", async () => {
      for (const status of [400, 401, 403, 404]) {
        const harness = new Harness({ toolbox: fakeToolbox({}), modelRetryBaseDelayMs: 1 });
        const policy = flaky(99, () => Object.assign(new Error("nope"), { status }));
        await run(harness, policy);
        assert.equal(policy.calls, 1, `status ${status} fails fast`);
      }
    });

    test("honors Retry-After, capped", async () => {
      const harness = new Harness({ toolbox: fakeToolbox({}), modelRetryMaxDelayMs: 5 });
      const headers = new Headers({ "retry-after": "30" });
      const policy = flaky(1, () => Object.assign(new Error("slow down"), { status: 429, headers }));
      const { events } = await run(harness, policy);
      assert.equal(events.find((e) => e.type === "model_retry").waitMs, 5, "30 s requested, capped at 5 ms");
    });

    test("streams draft text to the UI while the model is still writing", async () => {
      let seenLive;
      const delivered = new Promise((resolve) => (seenLive = resolve));
      const policy = {
        name: "streaming",
        async decide({ emit }) {
          emit({ type: "draft_delta", text: "Day 1" });
          // Only finish once the delta has reached onEvent (or give up after 1 s).
          const live = await Promise.race([delivered.then(() => true), new Promise((r) => setTimeout(() => r(false), 1000))]);
          return { answer: live ? "streamed live" : "buffered" };
        },
        observe() {},
      };
      const harness = new Harness({ toolbox: fakeToolbox({}) });
      const { answer } = await run(harness, policy, { onEvent: (e) => e.type === "draft_delta" && seenLive() });
      assert.equal(answer, "streamed live");
    });
  });
}
