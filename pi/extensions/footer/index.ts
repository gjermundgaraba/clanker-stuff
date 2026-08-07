import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createFooterHost } from "./host.js";

export default function footerExtension(pi: ExtensionAPI): void {
  const host = createFooterHost(pi);

  pi.registerCommand("footer", {
    description: "Configure or inspect the cooperative footer",
    handler: (args, ctx) => host.runCommand(args, ctx),
  });

  pi.on("session_start", (_event, ctx) => host.start(ctx));
  pi.on("model_select", (_event, ctx) => {
    host.refresh(ctx);
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    host.refresh(ctx);
  });
  pi.on("message_end", (_event, ctx) => {
    host.refresh(ctx);
  });
  pi.on("turn_end", (_event, ctx) => {
    host.turnEnd(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    host.refreshTotals(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    host.refreshTotals(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    host.refreshTotals(ctx);
  });
  pi.on("session_info_changed", (_event, ctx) => {
    host.refreshTotals(ctx);
  });
  pi.on("session_shutdown", () => {
    host.shutdown();
  });
}
