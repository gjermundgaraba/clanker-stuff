import { entryPad } from "@clanker-stuff/pi-tool-rendering/card";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ENDED, OPENED } from "./journal.js";
import { endedCard, openedCard, wakeMessage } from "./render.js";
import { WAKE_TYPE, WaitRuntime } from "./runtime.js";
import { listText, registerWaitTools } from "./tools.js";

export default function waits(pi: ExtensionAPI): void {
  const runtime = new WaitRuntime(pi);
  const pad = () => entryPad(pi.getSettings());
  registerWaitTools(pi, runtime);
  pi.registerEntryRenderer(OPENED, openedCard(pad));
  pi.registerEntryRenderer(
    ENDED,
    endedCard((id) => runtime.labelOf(id), pad)
  );
  pi.registerMessageRenderer(WAKE_TYPE, wakeMessage);
  pi.registerCommand("waits", {
    description: "List this session's live waits",
    handler: async (_args, ctx) => {
      ctx.ui.notify(listText(runtime.rows()), "info");
    },
  });
  pi.on("session_start", (_event, ctx) => {
    runtime.startSession(ctx);
  });
  pi.on("agent_settled", () => {
    runtime.gate.settled();
  });
  pi.on("ui_prompt_start", () => {
    runtime.gate.setPrompting(true);
  });
  pi.on("ui_prompt_end", () => {
    runtime.gate.setPrompting(false);
  });
  pi.on("session_shutdown", () => {
    runtime.shutdown();
  });
}
