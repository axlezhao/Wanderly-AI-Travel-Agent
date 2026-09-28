// Model registry: which "brains" the agent can use.
//
// Models come from three places:
//   1. the built-in rule-based demo policy (always available, no key)
//   2. environment variables in .env (ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY)
//   3. models you add in the UI ("Models" dialog), saved to models.local.json
//
// API keys never leave the server: the browser only sees a masked hint.
// Both .env and models.local.json are in .gitignore.

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { ClaudePolicy } from "../policies/claude.js";
import { OpenAICompatiblePolicy } from "../policies/openai-compatible.js";
import { DemoPolicy } from "../policies/demo.js";

export const PROVIDERS = ["anthropic", "openai-compatible"];

// Starting points for the "Add model" form. Model names change often; use
// "Discover models" in the UI to list what your key can actually access.
export const PRESETS = [
  { id: "deepseek", label: "DeepSeek", provider: "openai-compatible", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "anthropic", label: "Anthropic (Claude)", provider: "anthropic", baseUrl: "", model: "claude-opus-5", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", label: "OpenAI", provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "openrouter", label: "OpenRouter", provider: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "", keyUrl: "https://openrouter.ai/keys" },
  { id: "groq", label: "Groq", provider: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", model: "", keyUrl: "https://console.groq.com/keys" },
  { id: "ollama", label: "Ollama (local, no key)", provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "", keyUrl: null },
  { id: "custom", label: "Custom OpenAI-compatible", provider: "openai-compatible", baseUrl: "", model: "", keyUrl: null },
];

const DEMO = { id: "demo", label: "Demo · rule-based (no key)", provider: "demo", source: "builtin" };

export class ModelRegistry {
  constructor(file = "models.local.json") {
    this.file = file;
    this.userModels = this.#load();
  }

  #envModels() {
    const env = process.env;
    const out = [];
    if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
      const model = env.CLAUDE_MODEL || "claude-opus-5";
      out.push({ id: "env-anthropic", label: `Claude · ${model}`, provider: "anthropic", model, apiKey: env.ANTHROPIC_API_KEY, source: "env" });
    }
    if (env.DEEPSEEK_API_KEY) {
      for (const model of (env.DEEPSEEK_MODELS || "deepseek-flash,deepseek-v4-pro").split(",").map((m) => m.trim()).filter(Boolean)) {
        out.push({ id: `env-deepseek-${model}`, label: `DeepSeek · ${model}`, provider: "openai-compatible", baseUrl: "https://api.deepseek.com", model, apiKey: env.DEEPSEEK_API_KEY, source: "env" });
      }
    }
    if (env.OPENAI_API_KEY && env.OPENAI_MODEL) {
      out.push({ id: "env-openai", label: `OpenAI · ${env.OPENAI_MODEL}`, provider: "openai-compatible", baseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1", model: env.OPENAI_MODEL, apiKey: env.OPENAI_API_KEY, source: "env" });
    }
    return out;
  }

  all() {
    return [...this.#envModels(), ...this.userModels, DEMO];
  }

  get(id) {
    return this.all().find((m) => m.id === id) ?? null;
  }

  // Prefer a real LLM when one is configured.
  defaultId() {
    return (this.all().find((m) => m.provider !== "demo") ?? DEMO).id;
  }

  // What the browser is allowed to see.
  publicList() {
    return this.all().map(({ apiKey, ...m }) => ({ ...m, keyHint: apiKey ? `…${apiKey.slice(-4)}` : null }));
  }

  add(input) {
    const config = normalize(input);
    const model = { id: `user-${randomUUID().slice(0, 8)}`, ...config, source: "user" };
    this.userModels.push(model);
    this.#save();
    return model;
  }

  remove(id) {
    const before = this.userModels.length;
    this.userModels = this.userModels.filter((m) => m.id !== id);
    if (this.userModels.length !== before) this.#save();
    return this.userModels.length !== before;
  }

  createPolicy(model, tools) {
    switch (model.provider) {
      case "demo": return new DemoPolicy();
      case "anthropic": return new ClaudePolicy({ tools, model: model.model, apiKey: model.apiKey, baseUrl: model.baseUrl });
      case "openai-compatible": return new OpenAICompatiblePolicy({ tools, baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey });
      default: throw new Error(`Unknown provider "${model.provider}".`);
    }
  }

  #load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
  }

  #save() {
    // 0600: readable only by you, since the file holds API keys.
    fs.writeFileSync(this.file, JSON.stringify(this.userModels, null, 2), { mode: 0o600 });
  }
}

export function normalize(input = {}) {
  const provider = String(input.provider ?? "");
  if (!PROVIDERS.includes(provider)) throw new Error(`provider must be one of: ${PROVIDERS.join(", ")}`);
  const model = String(input.model ?? "").trim();
  if (!model) throw new Error("Model name is required.");
  const baseUrl = String(input.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (provider === "openai-compatible" && !/^https?:\/\//.test(baseUrl)) throw new Error("Base URL must start with http:// or https://");
  const apiKey = String(input.apiKey ?? "").trim() || undefined;
  if (provider === "anthropic" && !apiKey) throw new Error("An Anthropic API key is required.");
  const label = String(input.label ?? "").trim() || model;
  return { label, provider, baseUrl: baseUrl || undefined, model, apiKey };
}

// Turn low-level network errors into something a person can act on.
async function reach(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    const why = err.name === "TimeoutError" ? "timed out" : err.cause?.code ?? err.message;
    throw new Error(`Couldn't reach ${new URL(url).origin} (${why}). Check the base URL${url.includes("localhost") ? ", and that the local server is running" : ""}.`);
  }
}

// List the models a key can access (fills the model dropdown in the UI).
export async function discoverModels(input) {
  const { provider, baseUrl, apiKey } = { ...input, provider: String(input.provider ?? "") };
  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey, ...(baseUrl && { baseURL: baseUrl }) });
    const ids = [];
    for await (const m of client.models.list()) ids.push(m.id);
    return ids;
  }
  if (!/^https?:\/\//.test(String(baseUrl ?? ""))) throw new Error("Enter a base URL first.");
  const res = await reach(`${String(baseUrl).replace(/\/+$/, "")}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return (body.data ?? body.models ?? []).map((m) => m.id ?? m.name).filter(Boolean).sort();
}

// Send one tiny request to prove the key, URL and model work together.
export async function testModel(input) {
  const config = normalize(input);
  const started = Date.now();
  if (config.provider === "anthropic") {
    const client = new Anthropic({ apiKey: config.apiKey, ...(config.baseUrl && { baseURL: config.baseUrl }) });
    await client.messages.create({ model: config.model, max_tokens: 16, messages: [{ role: "user", content: "Reply with: ok" }] });
  } else {
    const res = await reach(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(config.apiKey && { Authorization: `Bearer ${config.apiKey}` }) },
      body: JSON.stringify({ model: config.model, max_tokens: 16, messages: [{ role: "user", content: "Reply with: ok" }] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return { latencyMs: Date.now() - started };
}
