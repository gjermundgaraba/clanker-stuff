import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createHistoryRuntime } from "./runtime.js";

export default function history(pi: ExtensionAPI): void {
  const runtime = createHistoryRuntime();

  pi.registerShortcut("ctrl+r", {
    description: "Search prompt history",
    handler: runtime.open,
  });

  pi.registerCommand("history-import", {
    description: "Import prompt history from existing sessions",
    handler: async (_args, ctx) => {
      await runtime.importHistory(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    runtime.start(ctx);
  });
  pi.on("input", runtime.recordInput);
  pi.on("user_bash", runtime.recordBash);
  pi.on("session_shutdown", runtime.dispose);
}
