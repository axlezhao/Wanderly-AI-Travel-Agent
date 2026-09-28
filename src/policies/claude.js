// Claude as the ReAct policy.
//
// Claude's native tool use maps directly onto ReAct:
//   Thought     = the short text Claude writes before calling tools
//   Action      = the tool_use blocks in that same response (possibly several, run in parallel)
//   Observation = the tool_result blocks we send back
//   Answer      = a response with no tool calls
//
// The conversation is kept per session and only ever appended to, so prompt
// caching keeps working across steps and turns.

import Anthropic from "@anthropic-ai/sdk";
import { systemPrompt } from "./prompt.js";

// Models that take adaptive thinking + effort; older ones get a plain request.
const MODERN = /claude-(opus-(4-[678]|5)|sonnet-(4-6|5)|fable|mythos)/;
// Models where the server-side refusal fallback is recommended.
const FALLBACK_MODELS = /^claude-(opus-5|fable-5-1)$/;

export class ClaudePolicy {
  name = "claude";

  /**
   * @param {object} p
   * @param {{name, description, inputSchema}[]} p.tools  tool definitions discovered over MCP
   * @param {string} p.model     e.g. "claude-opus-5"
   * @param {string} [p.apiKey]  defaults to ANTHROPIC_API_KEY
   * @param {string} [p.baseUrl] defaults to the Anthropic API
   */
  constructor({ tools, model, apiKey, baseUrl, effort = process.env.CLAUDE_EFFORT || "medium", client }) {
    // maxRetries: 0 — the harness retries model requests the same way for every provider.
    this.client = client ?? new Anthropic({ maxRetries: 0, ...(apiKey && { apiKey }), ...(baseUrl && { baseURL: baseUrl }) });
    this.model = model;
    this.effort = effort;
    this.modern = MODERN.test(model);
    this.useFallbacks = FALLBACK_MODELS.test(model) && !baseUrl;
    this.messages = [];
    this.usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    // MCP tool definitions -> Claude tool definitions.
    this.tools = tools.map(({ name, description, inputSchema }) => {
      const { $schema, ...input_schema } = inputSchema;
      return { name, description, input_schema, eager_input_streaming: true };
    });
  }

  addUserMessage(text) {
    // If the previous run was cancelled mid-step, its tool calls never got results.
    // Close them out (append-only) so the conversation stays valid.
    const last = this.messages.at(-1);
    const pending = last?.role === "assistant" && Array.isArray(last.content)
      ? last.content.filter((b) => b.type === "tool_use")
      : [];
    this.messages.push({
      role: "user",
      content: [
        ...pending.map((b) => ({ type: "tool_result", tool_use_id: b.id, content: "Cancelled by the user.", is_error: true })),
        { type: "text", text },
      ],
    });
  }

  // Short-term memory: catch up on turns another model handled in this session.
  seedHistory(entries) {
    for (const e of entries) {
      if (e.role === "user") this.addUserMessage(e.text);
      else this.messages.push({ role: "assistant", content: e.text });
    }
  }

  async decide({ forceAnswer, emit, signal }) {
    const message = await this.#callModel({ forceAnswer, emit, signal });
    this.messages.push({ role: "assistant", content: message.content });

    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const toolUses = message.content.filter((b) => b.type === "tool_use");

    if (message.stop_reason === "refusal") {
      return { answer: text || "Sorry, I can't help with that request. Try asking about a trip instead." };
    }
    if (message.stop_reason === "pause_turn") {
      return { thought: text, actions: [] }; // harness will simply call us again
    }
    if (toolUses.length === 0) {
      return { answer: text };
    }
    if (message.stop_reason === "max_tokens") {
      // A tool call cut off mid-input could run with truncated arguments; don't.
      throw new Error("The model ran out of output tokens while calling a tool.");
    }
    return {
      thought: text.replace(/^Thought:\s*/i, ""),
      actions: toolUses.map((b) => ({ id: b.id, tool: b.name, input: b.input })),
    };
  }

  observe(observations) {
    // All results from one step go back in a single user message.
    this.messages.push({
      role: "user",
      content: observations.map((o) => ({
        type: "tool_result",
        tool_use_id: o.id,
        content: o.content,
        is_error: o.isError,
      })),
    });
  }

  async #callModel({ forceAnswer, emit, signal }, attempt = 1) {
    const params = {
      model: this.model,
      max_tokens: 16000,
      system: systemPrompt(),
      tools: this.tools,
      messages: this.messages,
      cache_control: { type: "ephemeral" },
      ...(this.modern && { thinking: { type: "adaptive" }, output_config: { effort: this.effort } }),
      // On the last allowed step, answer with what we have.
      ...(forceAnswer && { tool_choice: { type: "none" } }),
    };
    const stream = this.useFallbacks
      ? // If a safety classifier declines, let the API retry on a suitable fallback model.
        this.client.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, { signal })
      : this.client.messages.stream(params, { signal });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        emit({ type: "draft_delta", text: event.delta.text });
      }
    }

    let message;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      // Only an unparseable streamed tool input is worth re-issuing; API errors propagate.
      if (err instanceof Anthropic.APIError || signal?.aborted || attempt >= 3) throw err;
      emit({ type: "draft_reset" });
      return this.#callModel({ forceAnswer, emit, signal }, attempt + 1);
    }

    const u = message.usage ?? {};
    this.usage.input_tokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    this.usage.output_tokens += u.output_tokens ?? 0;
    this.usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    return message;
  }
}
