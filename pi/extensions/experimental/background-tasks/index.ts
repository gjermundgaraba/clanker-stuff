import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TaskRuntime, renderWake } from "./runtime.js";
import { registerTaskTools } from "./register.js";

export default function backgroundTasks(pi: ExtensionAPI): void {
  const runtime = new TaskRuntime(pi);
  registerTaskTools(pi, runtime);
  pi.registerCommand("tasks", {
    description: "Inspect background task status and logs",
    handler: (args, ctx) => runtime.command(args, ctx),
  });
  pi.registerMessageRenderer("background-tasks:wake", renderWake);
  pi.on("session_start", (_event, ctx) => runtime.startSession(ctx));
  pi.on("agent_settled", () => runtime.settled());
  pi.on("agent_before_settle", (event, ctx) => runtime.beforeSettle(event, ctx));
  pi.on("context", (event, ctx) => runtime.context(event, ctx));
  pi.on("ui_prompt_start", () => runtime.prompt(true));
  pi.on("ui_prompt_end", () => runtime.prompt(false));
  pi.on("session_tree", (event, ctx) => runtime.tree(ctx, event.newLeafId));
  pi.on("session_shutdown", () => runtime.shutdown());
}
