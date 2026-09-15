import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createHistoryRuntime } from "./runtime.js";

export default function history(pi: ExtensionAPI): void {
  const runtime = createHistoryRuntime();

  pi.registerShortcut("ctrl+r", {
    description: "Search prompt history",
    handler: (ctx) => runtime.open(ctx),
  });

  pi.registerCommand("history-import", {
    description: "Import prompt history from existing sessions",
    handler: (_args, ctx) => runtime.importHistory(ctx),
  });

  pi.on("session_start", (event, ctx) => runtime.start(event, ctx));
  pi.on("input", (event, ctx) => runtime.recordInput(event, ctx));
  pi.on("user_bash", (event, ctx) => runtime.recordBash(event, ctx));
  pi.on("session_shutdown", (_event, ctx) => runtime.dispose(ctx));
}
