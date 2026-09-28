// Writes every harness event for a run to traces/<runId>.jsonl so you can see
// exactly what the agent thought, called and observed. Streaming deltas are
// skipped to keep files readable.

import fs from "node:fs";
import path from "node:path";

export class JsonlTracer {
  constructor(dir = "traces") {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  start(runId, meta = {}) {
    const file = path.join(this.dir, `${runId}.jsonl`);
    const stream = fs.createWriteStream(file, { flags: "a" });
    const write = (obj) => stream.write(JSON.stringify(obj) + "\n");
    write({ type: "meta", runId, startedAt: new Date().toISOString(), ...meta });
    return {
      file,
      log: (event) => {
        if (event.type === "draft_delta") return;
        // The UI payloads are large and already summarized; keep traces lean.
        const { ui, ...rest } = event;
        write(rest);
      },
      end: (summary) => {
        const u = summary.usage;
        console.log(
          `[run ${runId}] ${summary.status} · ${summary.steps} steps · ${summary.toolCalls} tool calls` +
            ` (${summary.cacheHits} cached, ${summary.retries} retries, ${summary.toolErrors} errors, ${summary.fallbacks ?? 0} fallbacks, ${summary.modelRetries ?? 0} model retries)` +
            ` · ${(summary.durationMs / 1000).toFixed(1)}s` +
            (u ? ` · ${u.input_tokens} in / ${u.output_tokens} out tokens` : "") +
            ` · ${file}`,
        );
        stream.end();
      },
    };
  }
}
