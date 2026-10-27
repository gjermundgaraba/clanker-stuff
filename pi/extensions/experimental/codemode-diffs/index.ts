import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { EditDiffs } from "./diffs.js";
import { createHighlightedEdit } from "./edit.js";
import { resolveRenderer } from "./renderer.js";

export default function codemodeDiffs(pi: ExtensionAPI): void {
  const diffs = new EditDiffs();

  pi.on("tool_call", (event) => {
    diffs.onCall(event);
  });
  pi.on("tool_result", (event) => diffs.onResult(event));
  pi.on("agent_end", () => {
    diffs.clear();
  });
  pi.on("session_start", () => {
    diffs.clear();
  });
  pi.on("session_shutdown", () => {
    diffs.clear();
  });
  pi.registerTool(createHighlightedEdit(diffs));
  pi.registerToolRenderer((name, next) => resolveRenderer(name, next));
}
