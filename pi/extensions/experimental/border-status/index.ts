import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBorderHost } from "./host.js";

export default function borderStatus(pi: ExtensionAPI): void {
  const host = createBorderHost(pi);
  pi.registerCommand("border-status", {
    description: "Configure shared editor-border status icons",
    handler: (args, ctx) => host.command(args, ctx),
  });
  pi.on("session_start", (_event, ctx) => host.start(ctx));
  pi.on("session_tree", (event, ctx) => host.navigate(ctx, event.newLeafId));
  pi.on("session_shutdown", () => host.shutdown());
}
