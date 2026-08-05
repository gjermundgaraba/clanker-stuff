import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createReverseSearch } from "./controller.js";

export default function codexReverseISearch(pi: ExtensionAPI): void {
  const search = createReverseSearch();

  pi.registerShortcut("ctrl+r", {
    description: "Search prompt history",
    handler: (ctx) => search.open(ctx),
  });

  pi.registerCommand("reverse-i-search-import", {
    description: "Import prompt history from existing sessions",
    handler: (_args, ctx) => search.importHistory(ctx),
  });

  pi.on("session_start", (_event, ctx) => search.start(ctx));
  pi.on("input", (event, ctx) => search.recordInput(event, ctx));
  pi.on("user_bash", (event, ctx) => search.recordBash(event, ctx));
  pi.on("session_shutdown", (_event, ctx) => search.dispose(ctx));
}
