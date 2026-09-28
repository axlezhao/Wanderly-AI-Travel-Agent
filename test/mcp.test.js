// Starts the real MCP server over stdio and checks its contract. These tests
// stay offline: schema validation happens before any tool touches the network.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { McpToolbox } from "../src/harness/toolbox.js";

const toolbox = new McpToolbox();
after(() => toolbox.close());

test("MCP server advertises the six travel tools with JSON schemas", async () => {
  const tools = await toolbox.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["find_attractions", "find_places", "get_exchange_rate", "get_travel_guide", "get_weather", "search_destination"],
  );
  for (const t of tools) {
    assert.ok(t.description.length > 40, `${t.name} has a useful description`);
    assert.equal(t.inputSchema.type, "object");
  }
  const places = tools.find((t) => t.name === "find_places");
  assert.deepEqual(places.inputSchema.required.sort(), ["category", "latitude", "longitude"]);
  assert.ok(places.inputSchema.properties.category.enum.includes("restaurant"));
});

test("MCP server rejects bad input with a clear, non-retryable error", async () => {
  const res = await toolbox.callTool("get_weather", { latitude: "north", longitude: 10 });
  assert.equal(res.isError, true);
  assert.equal(res.retryable, false);
  assert.match(res.text, /latitude/);

  const res2 = await toolbox.callTool("find_places", { latitude: 1, longitude: 2, category: "casino" });
  assert.equal(res2.isError, true);
  assert.match(res2.text, /category/);
});
