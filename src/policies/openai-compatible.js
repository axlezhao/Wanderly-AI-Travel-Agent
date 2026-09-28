// ReAct policy for any OpenAI-compatible Chat Completions API:
// DeepSeek, OpenAI, OpenRouter, Groq, Together, Mistral, a local Ollama or LM Studio…
//
// Same mapping as the Claude policy:
//   Thought     = assistant `content` written alongside tool calls
//   Action      = `tool_calls` (possibly several, run in parallel)
//   Observation = `role: "tool"` messages we send back
//   Answer      = an assistant message with no tool calls

import { systemPrompt } from "./prompt.js";

export class OpenAICompatiblePolicy {
  name = "openai-compatible";

  /**
   * @param {object} p
   * @param {{name, description, inputSchema}[]} p.tools  tool definitions discovered over MCP
   * @param {string} p.baseUrl  e.g. https://api.deepseek.com  (the part before /chat/completions)
   * @param {string} p.model    e.g. deepseek-flash
   * @param {string} [p.apiKey]
   */
  constructor({ tools, baseUrl, model, apiKey }) {
    this.url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.model = model;
    this.apiKey = apiKey;
    this.messages = [{ role: "system", content: systemPrompt() }];
    this.usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    // MCP tool definitions -> OpenAI function tools.
    this.tools = tools.map(({ name, description, inputSchema }) => {
      const { $schema, ...parameters } = inputSchema;
      return { type: "function", function: { name, description, parameters } };
    });
  }

  addUserMessage(text) {
    // Close out tool calls left unanswered by a cancelled run so the history stays valid.
    const last = this.messages.at(-1);
    for (const call of last?.role === "assistant" ? last.tool_calls ?? [] : []) {
      this.messages.push({ role: "tool", tool_call_id: call.id, content: "Cancelled by the user." });
    }
    this.messages.push({ role: "user", content: text });
  }

  // Short-term memory: catch up on turns another model handled in this session.
  seedHistory(entries) {
    for (const e of entries) {
      if (e.role === "user") this.addUserMessage(e.text);
      else this.messages.push({ role: "assistant", content: e.text });
    }
  }

  async decide({ forceAnswer, emit, signal }) {
    const { content, reasoning, toolCalls, finishReason } = await this.#callModel({ forceAnswer, emit, signal });

    const assistant = { role: "assistant", content: content || null };
    // Reasoning models (e.g. DeepSeek thinking mode) need their reasoning echoed back during tool use.
    if (reasoning) assistant.reasoning_content = reasoning;
    if (toolCalls.length) assistant.tool_calls = toolCalls;
    this.messages.push(assistant);

    const text = content.trim();
    if (toolCalls.length === 0) return { answer: text };
    if (finishReason === "length") throw new Error("The model ran out of output tokens while calling a tool.");
    return {
      thought: text.replace(/^Thought:\s*/i, ""),
      actions: toolCalls.map((c) => ({ id: c.id, tool: c.function.name, input: parseArgs(c.function.arguments) })),
    };
  }

  observe(observations) {
    for (const o of observations) {
      this.messages.push({ role: "tool", tool_call_id: o.id, content: o.content });
    }
  }

  async #callModel({ forceAnswer, emit, signal }) {
    const res = await fetch(this.url, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
      },
      body: JSON.stringify({
        model: this.model,
        messages: this.messages,
        tools: this.tools,
        tool_choice: forceAnswer ? "none" : "auto",
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${new URL(this.url).host} returned ${res.status}: ${body.slice(0, 300)}`);
    }

    let content = "", reasoning = "", finishReason = null;
    const calls = []; // tool calls stream in fragments, keyed by index

    for await (const data of sseEvents(res.body)) {
      if (data === "[DONE]") break;
      const chunk = JSON.parse(data);
      if (chunk.usage) {
        this.usage.input_tokens += chunk.usage.prompt_tokens ?? 0;
        this.usage.output_tokens += chunk.usage.completion_tokens ?? 0;
        this.usage.cache_read_input_tokens += chunk.usage.prompt_cache_hit_tokens ?? chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (delta.reasoning_content) reasoning += delta.reasoning_content;
      if (delta.content) {
        content += delta.content;
        emit({ type: "draft_delta", text: delta.content });
      }
      for (const tc of delta.tool_calls ?? []) {
        const slot = (calls[tc.index ?? calls.length] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
    return { content, reasoning, toolCalls, finishReason };
  }
}

// Malformed JSON becomes an empty input; the MCP server's schema check then
// returns a clear validation error the model can correct on its next step.
function parseArgs(raw) {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// Minimal Server-Sent Events reader: yields each `data:` payload.
async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}
