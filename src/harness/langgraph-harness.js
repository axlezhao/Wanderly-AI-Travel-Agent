// The same ReAct loop as harness.js, expressed as a LangGraph state graph.
// An optional alternative (HARNESS=langgraph), kept to compare the two styles.
//
//            ┌──────────────── no actions (model paused) ─────────────┐
//            ▼                                                         │
//   START ─▶ decide ──actions──▶ tool × N (one Send per Action) ─▶ observe
//            │  ▲                                                      │
//            │  └──────────────────────────────────────────────────────┘
//            └── answer / step limit ──▶ END
//
// It takes the same policies, emits the same events and returns the same
// result as ReActHarness, so the server, UI, evals and tests work with either.
// The step mechanics (model retries; tool timeouts, retries, circuit breaker,
// cache, truncation, LLM fallback) come from steps.js, shared with ReActHarness.
//
// What LangGraph does here:
//   - control flow is a graph (nodes + conditional edges) instead of a for loop
//   - parallel actions are a Send fan-out: one `tool` task per Action, run in the
//     same superstep, their observations merged by a state reducer
//   - events travel on LangGraph's "custom" stream (config.writer)
//   - cancellation goes through the graph's abort signal; recursionLimit backs up the step limit

import { Annotation, END, Send, START, StateGraph } from "@langchain/langgraph";
import { DEFAULTS, StepLimitError, decideWithRetries, newStats, runAction } from "./steps.js";

const replace = (_old, value) => value;

const RunState = Annotation.Root({
  step: Annotation({ reducer: replace, default: () => 0 }),
  // The Actions of the current step.
  actions: Annotation({ reducer: replace, default: () => [] }),
  // Observations of the current step: each tool task appends one; `decide` clears them (null).
  observations: Annotation({ reducer: (all, add) => (add === null ? [] : [...all, ...add]), default: () => [] }),
  answer: Annotation({ reducer: replace, default: () => null }),
});

export class LangGraphHarness {
  constructor({ toolbox, tracer = null, ...options }) {
    this.toolbox = toolbox;
    this.tracer = tracer;
    this.options = { ...DEFAULTS, ...options };
    this.graph = this.#build();
  }

  #build() {
    const { maxSteps } = this.options;
    // Per-run objects (policy, cache, stats…) can't live in graph state, which
    // must be plain data; they ride along in the run config.
    const run = (config) => config.configurable.run;

    const decide = async (state, config) => {
      const { policy, signal, stats } = run(config);
      const emit = config.writer;
      const step = state.step + 1;
      const forceAnswer = step === maxSteps;
      stats.steps = step;
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
        return { step, actions: [], answer: decision.answer };
      }
      const actions = decision.actions ?? [];
      emit({ type: "thought", step, text: decision.thought ?? "" });
      if (forceAnswer && actions.length) throw new StepLimitError(`Stopped after ${maxSteps} steps without a final answer.`);
      return { step, actions, observations: null };
    };

    // Fan out: one `tool` task per Action, all in the same superstep (so in parallel).
    const route = (state) => {
      if (state.answer !== null) return END;
      if (state.actions.length === 0) return state.step < maxSteps ? "decide" : END; // e.g. the model paused mid-turn
      return state.actions.map((action, index) => new Send("tool", { action, index, step: state.step }));
    };

    const tool = async ({ action, index, step }, config) => {
      const { signal, cache, stats, failures } = run(config);
      const observation = await runAction(action, {
        toolbox: this.toolbox, options: this.options, step, emit: config.writer, signal, cache, stats, failures,
      });
      return { observations: [{ ...observation, index }] };
    };

    // Runs once all of the step's tool tasks are done; hands their results back in Action order.
    const observe = (state, config) => {
      const observations = [...state.observations].sort((a, b) => a.index - b.index).map(({ index, ...o }) => o);
      run(config).policy.observe(observations);
      return {};
    };

    return new StateGraph(RunState)
      .addNode("decide", decide)
      .addNode("tool", tool)
      .addNode("observe", observe)
      .addEdge(START, "decide")
      .addConditionalEdges("decide", route, ["decide", "tool", END])
      .addEdge("tool", "observe")
      .addEdge("observe", "decide")
      .compile();
  }

  /** Same contract as ReActHarness.run. */
  async run({ policy, runId, onEvent = () => {}, signal, cache = new Map(), meta = {} }) {
    const { maxSteps } = this.options;
    const startedAt = Date.now();
    const trace = this.tracer?.start(runId, { policy: policy.name, harness: "langgraph", ...meta });
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
      const stream = await this.graph.stream({}, {
        streamMode: ["custom", "values"],
        signal,
        // decide + tool + observe per step; the step limit above normally ends the run first.
        recursionLimit: maxSteps * 3 + 2,
        configurable: { run: { policy, signal, cache, stats, failures } },
      });
      for await (const [mode, chunk] of stream) {
        if (mode === "custom") emit(chunk);
        else answer = chunk.answer;
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
