// Web server: serves the UI and streams ReAct runs to the browser.
//
//   browser ──POST /api/chat──▶ server.js ──▶ ReActHarness ──▶ policy (Claude, DeepSeek/OpenAI-compatible, or demo)
//                                                   │
//                                                   └──▶ McpToolbox ══stdio══▶ MCP server ──▶ free travel APIs
//
// Each response is newline-delimited JSON: one harness event per line.

import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ReActHarness } from "./src/harness/harness.js";
import { McpToolbox } from "./src/harness/toolbox.js";
import { JsonlTracer } from "./src/harness/tracer.js";
import { ModelRegistry, PRESETS, PROVIDERS, discoverModels, testModel } from "./src/models/registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// Localhost only by default: this server can hold API keys.
const HOST = process.env.HOST || "127.0.0.1";
const SESSION_TTL_MS = 60 * 60 * 1000;

const toolbox = new McpToolbox();
const harness = new ReActHarness({
  toolbox,
  tracer: new JsonlTracer(path.join(here, "traces")),
  maxSteps: Number(process.env.MAX_STEPS) || 8,
});

const models = new ModelRegistry(path.join(here, "models.local.json"));

// sessionId -> { policies: {modelId: policy}, cache, busy, lastUsed }
const sessions = new Map();
setInterval(() => {
  for (const [id, s] of sessions) if (Date.now() - s.lastUsed > SESSION_TTL_MS) sessions.delete(id);
}, 5 * 60 * 1000).unref();

// Each model keeps its own conversation history within a session.
async function getPolicy(session, model) {
  session.policies[model.id] ??= models.createPolicy(model, await toolbox.listTools());
  return session.policies[model.id];
}

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(here, "public")));

app.get("/api/status", async (_req, res) => {
  try {
    const tools = await toolbox.listTools();
    res.json({
      defaultModel: models.defaultId(),
      models: models.publicList(),
      presets: PRESETS,
      providers: PROVIDERS,
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
    });
  } catch (err) {
    res.status(500).json({ error: `MCP server failed to start: ${err.message}` });
  }
});

app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body ?? {};
  const model = models.get(req.body?.modelId ?? models.defaultId());
  if (!model) return res.status(400).json({ error: "Unknown model. Pick one from the model menu." });
  if (typeof sessionId !== "string" || typeof message !== "string" || !message.trim() || message.length > 2000) {
    return res.status(400).json({ error: "Expected { sessionId, message } with a message under 2000 characters." });
  }

  const session = sessions.get(sessionId) ?? { policies: {}, cache: new Map(), busy: false };
  sessions.set(sessionId, session);
  session.lastUsed = Date.now();
  if (session.busy) return res.status(409).json({ error: "Still working on your previous message." });
  session.busy = true;

  // Stop the run if the browser goes away (tab closed, Stop button).
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();

  try {
    const policy = await getPolicy(session, model);
    policy.addUserMessage(message.trim());
    await harness.run({
      policy,
      runId: `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 6)}`,
      cache: session.cache,
      signal: controller.signal,
      meta: { sessionId, model: model.model ?? model.id, provider: model.provider, message: message.trim() },
      onEvent: (event) => {
        if (!res.writableEnded) res.write(JSON.stringify(event) + "\n");
      },
    });
  } catch (err) {
    if (!res.writableEnded) res.write(JSON.stringify({ type: "error", message: err.message }) + "\n");
  } finally {
    session.busy = false;
    res.end();
  }
});

// ---- Model management (used by the "Models" dialog) ----
app.post("/api/models", (req, res) => {
  try {
    const { apiKey, ...model } = models.add(req.body);
    res.json({ model });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/models/:id", (req, res) => {
  if (!models.remove(req.params.id)) return res.status(404).json({ error: "Only models you added in the UI can be removed." });
  for (const s of sessions.values()) delete s.policies[req.params.id];
  res.json({ ok: true });
});

app.post("/api/models/test", async (req, res) => {
  try {
    res.json({ ok: true, ...(await testModel(req.body)) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/models/discover", async (req, res) => {
  try {
    res.json({ models: await discoverModels(req.body ?? {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/reset", (req, res) => {
  sessions.delete(req.body?.sessionId);
  res.json({ ok: true });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`\n  🧭 Wanderly travel agent running at http://localhost:${PORT}`);
  console.log(`     Models: ${models.all().map((m) => m.label).join(" | ")}`);
  console.log(`     Default: ${models.get(models.defaultId()).label}\n`);
});

async function shutdown() {
  server.close();
  await toolbox.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
