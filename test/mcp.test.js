// Contract tests for the MCP tool server. The same tests run against both
// implementations (Node: src/mcp/server.js, Go: mcp-go/) to prove they are
// interchangeable. These stay offline: schema validation happens before any
// tool touches the network.

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { McpToolbox, serverParamsFor } from "../src/harness/toolbox.js";

const EXPECTED_TOOLS = ["compare_routes", "find_attractions", "find_places", "get_exchange_rate", "get_travel_guide", "get_weather", "search_destination"];

const goAvailable = (() => {
  if (fs.existsSync(serverParamsFor("go").command)) return true;
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const toolboxes = {};
after(() => Promise.all(Object.values(toolboxes).map((t) => t.close())));

for (const kind of ["node", "go"]) {
  describe(`${kind} MCP server`, { skip: kind === "go" && !goAvailable && "Go is not installed" }, () => {
    const toolbox = (toolboxes[kind] = new McpToolbox(serverParamsFor(kind)));

    test("advertises the seven travel tools with JSON schemas", async () => {
      const tools = await toolbox.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
      for (const t of tools) {
        assert.ok(t.description.length > 40, `${t.name} has a useful description`);
        assert.equal(t.inputSchema.type, "object");
      }
      const places = tools.find((t) => t.name === "find_places");
      assert.deepEqual([...places.inputSchema.required].sort(), ["category", "latitude", "longitude"]);
      assert.ok(places.inputSchema.properties.category.enum.includes("restaurant"));
    });

    test("rejects bad input with a clear, non-retryable error", async () => {
      const res = await toolbox.callTool("get_weather", { latitude: "north", longitude: 10 });
      assert.equal(res.isError, true);
      assert.equal(res.retryable, false);
      assert.match(res.text, /latitude/);

      const res2 = await toolbox.callTool("find_places", { latitude: 1, longitude: 2, category: "casino" });
      assert.equal(res2.isError, true);
      assert.match(res2.text, /category|casino/);

      const res3 = await toolbox.callTool("get_weather", { latitude: 100, longitude: 10 });
      assert.equal(res3.isError, true, "latitude above 90 is out of range");
    });

    test("same-currency conversion works without the network", async () => {
      const res = await toolbox.callTool("get_exchange_rate", { from: "eur", to: "EUR", amount: 42 });
      assert.equal(res.isError, false);
      assert.deepEqual(JSON.parse(res.text), { from: "EUR", to: "EUR", rate: 1, amount: 42, converted: 42 });
      assert.equal(res.ui.kind, "currency");
    });
  });
}

describe("Node and Go servers are interchangeable", { skip: !goAvailable && "Go is not installed" }, () => {
  test("identical tool names, required fields, types, ranges and enums", async () => {
    const shape = (tools) =>
      Object.fromEntries(
        tools.map((t) => [
          t.name,
          {
            required: [...(t.inputSchema.required ?? [])].sort(),
            properties: Object.fromEntries(
              Object.entries(t.inputSchema.properties).map(([k, p]) => [
                k,
                { type: p.type, minimum: p.minimum, maximum: p.maximum, enum: p.enum, pattern: p.pattern },
              ]),
            ),
          },
        ]),
      );
    const node = toolboxes.node ?? new McpToolbox(serverParamsFor("node"));
    const go = toolboxes.go ?? new McpToolbox(serverParamsFor("go"));
    assert.deepEqual(shape(await go.listTools()), shape(await node.listTools()));
  });
});
