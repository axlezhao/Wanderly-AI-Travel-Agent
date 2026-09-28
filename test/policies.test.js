// Offline tests for the policies: the demo request parser, and the
// OpenAI-compatible policy against a local mock server that streams tool calls
// the way DeepSeek/OpenAI do (fragments spread across SSE chunks).

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { parseRequest } from "../src/policies/demo.js";
import { OpenAICompatiblePolicy } from "../src/policies/openai-compatible.js";
import { normalize } from "../src/models/registry.js";

test("demo parser extracts destination and trip length", () => {
  const cases = [
    ["Plan 4 days in Lisbon", "Lisbon", 4],
    ["A food-focused weekend in Lisbon", "Lisbon", 2],
    ["I want a weekend trip to Mexico City with good food", "Mexico City", 2],
    ["what should I do in new york for two days", "New York", 2],
    ["Plan a trip to Rio de Janeiro", "Rio de Janeiro", 3],
    ["Take me to Paris for a week", "Paris", 7],
    ["Kyoto", "Kyoto", 3],
    ["5 days exploring seoul", "Seoul", 5],
  ];
  for (const [message, destination, days] of cases) {
    assert.deepEqual(parseRequest(message), { destination, days }, message);
  }
});

test("model config validation", () => {
  assert.throws(() => normalize({ provider: "nope", model: "x" }), /provider/);
  assert.throws(() => normalize({ provider: "openai-compatible", model: "" }), /Model name/);
  assert.throws(() => normalize({ provider: "openai-compatible", model: "m", baseUrl: "api.x.com" }), /http/);
  assert.throws(() => normalize({ provider: "anthropic", model: "claude-opus-5" }), /key/);
  assert.deepEqual(normalize({ provider: "openai-compatible", model: "m", baseUrl: "http://localhost:11434/v1/" }), {
    label: "m", provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "m", apiKey: undefined,
  });
});

// A tiny stand-in for an OpenAI-compatible server. Each request pops the next scripted reply.
async function mockServer(replies) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const chunk of replies.shift()) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => server.close() };
}

const delta = (d, finish = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
const TOOLS = [{ name: "search_destination", description: "find", inputSchema: { $schema: "x", type: "object", properties: { query: { type: "string" } } } }];

test("OpenAI-compatible policy: streams a thought, assembles fragmented tool calls, then answers", async () => {
  const mock = await mockServer([
    [
      delta({ role: "assistant", content: "Thought: I need " }),
      delta({ content: "coordinates." }),
      delta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "search_destination", arguments: '{"que' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'ry": "Kyoto"}' } }] }),
      delta({ tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "search_destination", arguments: '{"query":"Osaka"}' } }] }),
      delta({}, "tool_calls"),
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
    ],
    [delta({ content: "# Kyoto plan" }), delta({}, "stop"), { choices: [], usage: { prompt_tokens: 150, completion_tokens: 30 } }],
  ]);
  try {
    const policy = new OpenAICompatiblePolicy({ tools: TOOLS, baseUrl: mock.url, model: "mock-1", apiKey: "test-key" });
    policy.addUserMessage("3 days in Kyoto");
    const streamed = [];
    const emit = (e) => streamed.push(e.text);

    const step1 = await policy.decide({ emit, forceAnswer: false });
    assert.equal(step1.thought, "I need coordinates.");
    assert.deepEqual(step1.actions, [
      { id: "call_1", tool: "search_destination", input: { query: "Kyoto" } },
      { id: "call_2", tool: "search_destination", input: { query: "Osaka" } },
    ]);
    assert.equal(streamed.join(""), "Thought: I need coordinates.");

    const req1 = mock.requests[0];
    assert.equal(req1.headers.authorization, "Bearer test-key");
    assert.equal(req1.body.model, "mock-1");
    assert.equal(req1.body.tool_choice, "auto");
    assert.equal(req1.body.tools[0].function.parameters.$schema, undefined, "$schema is stripped");

    policy.observe([
      { id: "call_1", tool: "search_destination", content: '{"lat":35}', isError: false },
      { id: "call_2", tool: "search_destination", content: '{"lat":34}', isError: false },
    ]);
    const step2 = await policy.decide({ emit, forceAnswer: true });
    assert.equal(step2.answer, "# Kyoto plan");

    const msgs = mock.requests[1].body.messages;
    assert.equal(mock.requests[1].body.tool_choice, "none", "forced final step disables tools");
    assert.deepEqual(msgs.map((m) => m.role), ["system", "user", "assistant", "tool", "tool"]);
    assert.equal(msgs[2].tool_calls.length, 2);
    assert.equal(msgs[3].tool_call_id, "call_1");
    assert.deepEqual(policy.usage, { input_tokens: 250, output_tokens: 50, cache_read_input_tokens: 0 });
  } finally {
    mock.close();
  }
});

test("OpenAI-compatible policy: closes out tool calls left open by a cancelled run", () => {
  const policy = new OpenAICompatiblePolicy({ tools: TOOLS, baseUrl: "http://unused", model: "m" });
  policy.messages.push({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }] });
  policy.addUserMessage("next question");
  assert.deepEqual(policy.messages.slice(-2).map((m) => m.role), ["tool", "user"]);
  assert.equal(policy.messages.at(-2).tool_call_id, "c1");
});
