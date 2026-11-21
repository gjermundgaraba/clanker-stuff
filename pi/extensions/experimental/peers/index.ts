import { entryPad } from "@clanker-stuff/pi-tool-rendering/card";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { SENT, UNDELIVERED } from "./entries.js";
import { receivedMessage, sentCard, undeliveredCard } from "./render.js";
import { peerRows } from "./report.js";
import { MESSAGE_TYPE, PeerRuntime } from "./runtime.js";
import { registerPeerTools } from "./tools.js";

export default function peers(pi: ExtensionAPI): void {
  const runtime = new PeerRuntime(pi);
  const pad = () => entryPad(pi.getSettings());
  registerPeerTools(pi, runtime);
  pi.registerMessageRenderer(MESSAGE_TYPE, receivedMessage);
  pi.registerEntryRenderer(SENT, sentCard(pad));
  pi.registerEntryRenderer(UNDELIVERED, undeliveredCard(pad));
  pi.registerCommand("peers", {
    description: "List running Pi sessions that have a peer name",
    handler: async (_args, ctx) => {
      ctx.ui.notify(peerRows(await runtime.peers()), "info");
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
