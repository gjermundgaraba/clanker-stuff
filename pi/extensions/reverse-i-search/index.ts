import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createReverseSearchRuntime } from "./runtime.js";

export default function codexReverseISearch(pi: ExtensionAPI): void {
  const reverseSearch = createReverseSearchRuntime();

  pi.registerShortcut("ctrl+r", {
    description: "Search prompt history",
    handler: (ctx) => reverseSearch.open(ctx),
  });

  pi.registerCommand("reverse-i-search-import", {
    description: "Import prompt history from existing sessions",
    handler: (_args, ctx) => reverseSearch.importHistory(ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    reverseSearch.sessionStart(ctx);
  });
  pi.on("input", (event, ctx) =>
    event.source === "interactive" ? reverseSearch.recordInput(event, ctx) : undefined,
  );
  pi.on("user_bash", (event, ctx) => reverseSearch.recordBash(event, ctx));
  pi.on("session_shutdown", (_event, ctx) => reverseSearch.shutdown(ctx));
}
