import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { WaitRuntime } from "./runtime.js";
import { registerWaitTools } from "./tools.js";

export default function waits(pi: ExtensionAPI): void {
  const runtime = new WaitRuntime(pi);
  registerWaitTools(pi, runtime);
  pi.registerCommand("waits", {
    description: "List this session's live waits",
    handler: async (_args, ctx) => {
      ctx.ui.notify(runtime.rows(), "info");
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
