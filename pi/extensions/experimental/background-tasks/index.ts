import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TaskRuntime } from "./runtime.js";
import { registerTaskTools } from "./register.js";

export default function backgroundTasks(pi: ExtensionAPI): void {
  const runtime = new TaskRuntime(pi);
  registerTaskTools(pi, runtime);
  pi.registerCommand("tasks", {
    description: "List background tasks, or show one task's status and log tails",
    handler: (args, ctx) => runtime.command(args, ctx),
  });
  pi.on("session_start", (_event, ctx) => runtime.startSession(ctx));
  pi.on("agent_settled", () => runtime.settled());
  pi.on("ui_prompt_start", () => runtime.prompt(true));
  pi.on("ui_prompt_end", () => runtime.prompt(false));
  pi.on("session_tree", (_event, ctx) => runtime.tree(ctx));
  pi.on("session_shutdown", () => runtime.shutdown());
}
