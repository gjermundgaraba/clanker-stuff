import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { WaitRuntime } from "./runtime.js";
import { registerWaitTools } from "./tools.js";

export default function waits(pi: ExtensionAPI): void {
  const runtime = new WaitRuntime(pi);
  registerWaitTools(pi, runtime);
  pi.registerCommand("waits", {
    description: "List this branch's waits",
    handler: async (_args, ctx) => {
      ctx.ui.notify(runtime.rows(), "info");
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    await runtime.startSession(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await runtime.tree(ctx);
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
  pi.on("session_before_compact", () => {
    runtime.gate.setCompacting(true);
  });
  pi.on("session_compact", () => {
    runtime.gate.setCompacting(false);
  });
  pi.on("session_compact_failed", () => {
    runtime.gate.setCompacting(false);
  });
  pi.on("session_shutdown", () => {
    runtime.shutdown();
  });
}
