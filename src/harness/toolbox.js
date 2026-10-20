// MCP client "toolbox": starts the travel-tools MCP server as a child process,
// discovers its tools, and calls them. The harness only depends on the small
// interface below, so tests can swap in a fake toolbox.
//
//   interface Toolbox {
//     listTools(): Promise<{ name, description, inputSchema }[]>
//     callTool(name, input, { signal, timeoutMs }): Promise<{ text, ui, isError, retry?, invalidInput? }>
//       retry         on errors: "transient" | "once" | "never" (see src/tools/travel-apis.js)
//       invalidInput  the call was rejected before any tool code ran (arguments failed
//                     the schema, unknown tool): only the model can fix it
//     close(): Promise<void>
//   }

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");

// Two interchangeable implementations of the same MCP server:
//   node (default)  src/mcp/server.js
//   go              mcp-go/  (the compiled binary if you ran `npm run build:go`, else `go run`)
export function serverParamsFor(kind = process.env.MCP_SERVER || "node") {
  if (kind === "go") {
    const binary = path.join(root, "mcp-go", "bin", process.platform === "win32" ? "wanderly-mcp.exe" : "wanderly-mcp");
    return fs.existsSync(binary)
      ? { kind, command: binary, args: [] }
      : { kind, command: "go", args: ["run", "."], cwd: path.join(root, "mcp-go") };
  }
  return { kind: "node", command: process.execPath, args: [path.join(root, "src", "mcp", "server.js")] };
}

export class McpToolbox {
  constructor(serverParams = serverParamsFor()) {
    this.kind = serverParams.kind ?? "custom";
    this.serverParams = serverParams;
    this.client = null;
    this.tools = null;
    this.connecting = null;
  }

  async connect() {
    if (this.client) return;
    // Share one in-flight connection attempt between concurrent callers.
    this.connecting ??= (async () => {
      const client = new Client({ name: "travel-agent-harness", version: "1.0.0" });
      const { kind, ...params } = this.serverParams;
      const transport = new StdioClientTransport({ ...params, stderr: "pipe" });
      transport.stderr?.on("data", (d) => process.stderr.write(`[mcp] ${d}`));
      // If the server process dies, reconnect on the next call.
      transport.onclose = () => {
        this.client = null;
        this.tools = null;
      };
      await client.connect(transport);
      this.client = client;
    })().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  async listTools() {
    await this.connect();
    if (!this.tools) {
      const { tools } = await this.client.listTools();
      this.tools = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    }
    return this.tools;
  }

  async callTool(name, input, { signal, timeoutMs = 30000 } = {}) {
    await this.connect();
    let res;
    try {
      res = await this.client.callTool({ name, arguments: input }, undefined, { signal, timeout: timeoutMs });
    } catch (err) {
      // Some servers reject bad arguments or an unknown tool as a protocol error (the Go SDK
      // does for unknown tools). Anything else (timeout, crash) is left to the harness.
      if (err instanceof McpError && err.code === ErrorCode.InvalidParams) {
        return { text: `Error: ${err.message}`, ui: null, isError: true, retry: "never", invalidInput: true };
      }
      throw err;
    }
    const text = (res.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (!res.isError) return { text, ui: res._meta?.ui ?? null, isError: false };
    // Our tools always say how to retry. An error without _meta.retry came from the MCP SDK
    // itself, before any tool code ran: the same call would fail the same way.
    const retry = res._meta?.retry;
    return { text, ui: null, isError: true, retry: retry ?? "never", invalidInput: !retry };
  }

  async close() {
    await this.client?.close();
    this.client = null;
  }
}
