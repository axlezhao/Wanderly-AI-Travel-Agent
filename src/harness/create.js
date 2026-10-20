// Pick a harness by name. Both take the same options, accept the same policies
// and emit the same events.
//   react      the hand-written ReAct loop (default)
//   langgraph  the same loop as a LangGraph state graph

import { ReActHarness } from "./harness.js";
import { LangGraphHarness } from "./langgraph-harness.js";

export const HARNESSES = { react: ReActHarness, langgraph: LangGraphHarness };

export function createHarness(kind = "react", options) {
  const Harness = HARNESSES[kind];
  if (!Harness) throw new Error(`Unknown harness "${kind}". Use one of: ${Object.keys(HARNESSES).join(", ")}.`);
  return new Harness(options);
}
