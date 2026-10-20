#!/usr/bin/env node
// Eval harness: runs realistic trip requests end to end (model -> ReAct harness
// -> MCP -> live APIs) and scores each run with automatic checks.
//
//   npm run eval                          # default model (first one configured)
//   npm run eval -- --model demo          # a specific model id (see /api/status or the Models dialog)
//   npm run eval -- --only kyoto,lisbon   # a subset of scenarios
//   npm run eval -- --list                # show model ids
//   npm run eval -- --harness langgraph   # run through the LangGraph harness instead of the ReAct loop
//   npm run eval -- --harness react,langgraph   # both, side by side, with a comparison
//
// Results are printed as a table and saved to evals/results/<time>_<model>.json,
// so you can compare models or prompt changes over time.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESSES, createHarness } from "../src/harness/create.js";
import { McpToolbox } from "../src/harness/toolbox.js";
import { JsonlTracer } from "../src/harness/tracer.js";
import { ModelRegistry } from "../src/models/registry.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// ---------------------------------------------------------------------------
// Scenarios. Each check gets the run record and returns true/false.
// ---------------------------------------------------------------------------
const called = (tool, pred = () => true) => (r) => r.actions.some((a) => a.tool === tool && pred(a.input));
const mentionsDays = (n) => (r) => Array.from({ length: n }, (_, i) => `Day ${i + 1}`).every((d) => r.answer.includes(d));
// Grounding: the answer should recommend real places the tools returned, not invented ones.
const grounded = (kind, min) => (r) => r.namesFrom(kind).filter((n) => r.answer.includes(n)).length >= min;

const SCENARIOS = [
  {
    id: "kyoto",
    prompt: "Plan 3 days in Kyoto",
    checks: {
      "looks up destination first": (r) => r.actions[0]?.tool === "search_destination",
      "checks weather": called("get_weather"),
      "finds sights": called("find_attractions"),
      "has Day 1–3": mentionsDays(3),
      "names ≥3 real sights": grounded("attractions", 3),
      "≤ 6 steps": (r) => r.end.steps <= 6,
    },
  },
  {
    id: "lisbon-food",
    prompt: "A food-focused weekend in Lisbon",
    checks: {
      "searches restaurants": called("find_places", (i) => i.category === "restaurant"),
      "has Day 1–2": mentionsDays(2),
      "names ≥2 real restaurants/cafés": grounded("places", 2),
      "mentions currency": (r) => /€|EUR|euro/i.test(r.answer),
    },
  },
  {
    id: "far-dates",
    prompt: "I'm going to Reykjavik for 4 days from March 3 to March 6 next year. What should I plan and pack?",
    checks: {
      "asks weather for those dates": called("get_weather", (i) => /-03-0[3-6]$/.test(i.start_date ?? "")),
      "explains it's last year's weather": (r) =>
        r.observations.some((o) => o.ui?.kind === "weather" && o.ui.source === "same_dates_last_year") &&
        /last year|historical|same dates/i.test(r.answer),
      "has Day 1–4": mentionsDays(4),
    },
  },
  {
    id: "unknown-place",
    prompt: "Plan 2 days in Qwxzplkvania",
    checks: {
      "finishes without crashing": (r) => r.end.status === "ok",
      "admits it can't find the place": (r) => /couldn.?t|could not|can.?t find|not find|unable|no (place|results?|match)|doesn.?t (seem to )?(exist|match)|not a real|typo|made.up/i.test(r.answer),
      "doesn't invent an itinerary": (r) => !r.answer.includes("Day 2"),
    },
  },
];

// ---------------------------------------------------------------------------
const registry = new ModelRegistry(path.join(root, "models.local.json"));
if (args.includes("--list")) {
  for (const m of registry.publicList()) console.log(`${m.id.padEnd(34)} ${m.label}`);
  process.exit(0);
}
const model = registry.get(flag("model") ?? registry.defaultId());
if (!model) {
  console.error(`Unknown model "${flag("model")}". Run with --list to see ids.`);
  process.exit(1);
}
const only = flag("only")?.split(",");
const scenarios = SCENARIOS.filter((s) => !only || only.includes(s.id));

const harnessKinds = (flag("harness") ?? "react").split(",");
for (const kind of harnessKinds) {
  if (!HARNESSES[kind]) {
    console.error(`Unknown harness "${kind}". Use one of: ${Object.keys(HARNESSES).join(", ")}.`);
    process.exit(1);
  }
}

// Each harness gets its own MCP server, so one can't benefit from the other's tool cache.
const runners = harnessKinds.map((kind) => {
  const toolbox = new McpToolbox();
  return { kind, toolbox, harness: createHarness(kind, { toolbox, tracer: new JsonlTracer(path.join(root, "traces")) }) };
});
const tools = await runners[0].toolbox.listTools();

console.log(`\nEvaluating ${model.label} on ${scenarios.length} scenario(s) with harness: ${harnessKinds.join(", ")}…\n`);
const results = [];

for (const [i, scenario] of scenarios.entries()) {
  // Alternate which harness goes first, so neither always gets the warmer public APIs.
  const order = i % 2 ? [...runners].reverse() : runners;
  for (const { kind, harness } of order) {
    const events = [];
    const policy = registry.createPolicy(model, tools);
    policy.addUserMessage(scenario.prompt);
    const runId = `eval_${scenario.id}_${kind}_${Date.now()}`;
    process.stdout.write(`▶ ${scenario.id.padEnd(14)}${runners.length > 1 ? kind.padEnd(10) : ""}`);
    await harness.run({ policy, runId, onEvent: (e) => events.push(e), meta: { eval: scenario.id, model: model.id } });

    const record = {
      answer: events.find((e) => e.type === "answer")?.text ?? "",
      actions: events.filter((e) => e.type === "action"),
      observations: events.filter((e) => e.type === "observation"),
      end: events.find((e) => e.type === "run_end"),
      namesFrom: (kind) => events.filter((e) => e.type === "observation" && e.ui?.kind === kind).flatMap((e) => e.ui.items.map((i) => i.name)),
    };
    const checks = Object.entries(scenario.checks).map(([name, fn]) => {
      let pass = false;
      try { pass = Boolean(fn(record)); } catch {}
      return { name, pass };
    });
    const passed = checks.filter((c) => c.pass).length;
    const e = record.end;
    console.log(
      `${passed}/${checks.length} checks · ${e.steps} steps · ${e.toolCalls} tools · ${(e.durationMs / 1000).toFixed(1)}s` +
        (e.usage ? ` · ${e.usage.input_tokens + e.usage.output_tokens} tokens` : ""),
    );
    for (const c of checks) console.log(`    ${c.pass ? "✔" : "✘"} ${c.name}`);
    results.push({ scenario: scenario.id, harness: kind, prompt: scenario.prompt, runId, checks, stats: e, answer: record.answer });
  }
}

await Promise.all(runners.map((r) => r.toolbox.close()));

const scores = {};
for (const kind of harnessKinds) {
  const mine = results.filter((r) => r.harness === kind);
  scores[kind] = {
    passed: mine.reduce((n, r) => n + r.checks.filter((c) => c.pass).length, 0),
    total: mine.reduce((n, r) => n + r.checks.length, 0),
    steps: mine.reduce((n, r) => n + r.stats.steps, 0),
    toolCalls: mine.reduce((n, r) => n + r.stats.toolCalls, 0),
    durationMs: mine.reduce((n, r) => n + r.stats.durationMs, 0),
  };
}
console.log("");
for (const [kind, s] of Object.entries(scores)) {
  console.log(
    `Score${runners.length > 1 ? ` (${kind})` : ""}: ${s.passed}/${s.total} checks passed (${Math.round((s.passed / s.total) * 100)}%)` +
      (runners.length > 1 ? ` · ${s.steps} steps · ${s.toolCalls} tools · ${(s.durationMs / 1000).toFixed(1)}s total` : ""),
  );
}
if (runners.length > 1) {
  // Same model and prompt, so differences come from the harness (or from the model's own randomness).
  const [a, b] = harnessKinds;
  const differ = scenarios.filter((sc) => {
    const [ra, rb] = [a, b].map((k) => results.find((r) => r.scenario === sc.id && r.harness === k));
    return ra.checks.some((c, i) => c.pass !== rb.checks[i].pass) || ra.stats.steps !== rb.stats.steps || ra.stats.toolCalls !== rb.stats.toolCalls;
  });
  console.log(differ.length ? `Behaved differently on: ${differ.map((sc) => sc.id).join(", ")}` : `${a} and ${b} took the same steps and tool calls and passed the same checks.`);
}

const outDir = path.join(root, "evals", "results");
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${model.id}_${harnessKinds.join("-")}.json`);
fs.writeFileSync(file, JSON.stringify({ model: { id: model.id, label: model.label }, harnesses: harnessKinds, scores, results }, null, 2));
console.log(`Saved ${path.relative(root, file)}\n`);
