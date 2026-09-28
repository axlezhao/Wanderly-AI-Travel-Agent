// MCP client "toolbox": starts the travel-tools MCP server as a child process,
// discovers its tools, and calls them. The harness only depends on the small
// interface below, so tests can swap in a fake toolbox.
//
//   interface Toolbox {
//     listTools(): Promise<{ name, description, inputSchema }[]>
//     callTool(name, input, { signal, timeoutMs }): Promise<{ text, ui, isError, retryable }>
//     close(): Promise<void>
//   }

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVER = {
  command: process.execPath, // the same `node` running this app
  args: [path.join(here, "..", "mcp", "server.js")],
};

export class McpToolbox {
  constructor(serverParams = DEFAULT_SERVER) {
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
      const transport = new StdioClientTransport({ ...this.serverParams, stderr: "pipe" });
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
    const res = await this.client.callTool({ name, arguments: input }, undefined, { signal, timeout: timeoutMs });
    const text = (res.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return {
      text,
      ui: res._meta?.ui ?? null,
      isError: Boolean(res.isError),
      retryable: Boolean(res._meta?.retryable),
    };
  }

  async close() {
    await this.client?.close();
    this.client = null;
  }
}
