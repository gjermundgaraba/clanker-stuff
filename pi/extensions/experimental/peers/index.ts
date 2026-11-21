import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { PeerRuntime } from "./runtime.js";
import { registerPeerTools } from "./tools.js";

export default function peers(pi: ExtensionAPI): void {
  const runtime = new PeerRuntime(pi);
  registerPeerTools(pi, runtime);
  pi.registerCommand("peers", {
    description: "List running Pi sessions that have a peer name",
    handler: async (_args, ctx) => {
      ctx.ui.notify(await runtime.rows(), "info");
    },
  });
  pi.on("session_start", (_event, ctx) => {
    runtime.startSession(ctx);
  });
  pi.on("session_info_changed", () => {
    runtime.renamed();
  });
  pi.on("session_shutdown", async () => {
    await runtime.shutdown();
  });
}
