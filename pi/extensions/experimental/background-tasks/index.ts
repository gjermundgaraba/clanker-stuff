import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TaskRuntime, renderWake } from "./runtime.js";
import {
  startSchema,
  inspectSchema,
  prepareInspectArguments,
  idSchema,
  listSchema,
} from "./task.js";

export default function backgroundTasks(pi: ExtensionAPI): void {
  const runtime = new TaskRuntime(pi);
  pi.registerTool({
    name: "task_start",
    label: "Start task",
    description:
      "Run an executable without blocking. Session-owned: stops on reload/quit/session replacement. Optional events-v1 watcher emits strict JSONL event/result records on stdout, diagnostics on stderr. Ordinary output is logs, not automatic context. Default deadline 1 hour. Maximum 8 live tasks.",
    promptSnippet:
      "Start a session-owned background job or watcher; notifications require /tasks resume",
    promptGuidelines: [
      "Notifications start held; only the user can authorize eight automatic batches with confirmed /tasks resume. Otherwise inspect on demand and task_dismiss completed notices.",
      "After task_start, continue useful work or end the turn; do not block or repeatedly poll task_list while waiting.",
      "Use task_start with protocol events-v1 only for scripts emitting {v:1,type:'event',data:...} or terminal {v:1,type:'result',data:...} JSON records followed by LF. Keep external detection logic in the script.",
    ],
    parameters: startSchema,
    execute: (_id, params, signal, _update, ctx) => runtime.start(params, ctx, signal),
  });
  pi.registerTool({
    name: "task_list",
    label: "List tasks",
    description:
      "List bounded task status and attention budget; does not fetch logs or wake the model.",
    parameters: listSchema,
    execute: async () => runtime.list(),
  });
  pi.registerTool({
    name: "task_inspect",
    label: "Inspect task",
    description:
      "Pull untrusted task data. view summary returns status, all retained event IDs and log tails (up to 6000 bytes/stream by default, 12000 requested max). view result or event returns JSON text in payload.text; event requires eventId. Concatenate pages using payload.nextOffset as offset until null, then parse JSON. Total response capped at 32000 bytes; history may be evicted.",
    parameters: inspectSchema,
    prepareArguments: prepareInspectArguments,
    execute: async (_id, params) => runtime.inspect(params),
  });
  pi.registerTool({
    name: "task_stop",
    label: "Stop task",
    description:
      "Cancel an owned task, await bounded process-group cleanup, and report the actual outcome. Does not cancel independent observed jobs.",
    parameters: idSchema,
    execute: (_id, params) => runtime.stop(params.id),
  });
  pi.registerTool({
    name: "task_dismiss",
    label: "Dismiss task notice",
    description:
      "Explicitly discard a terminal task's pending notices after cleanup, releasing inbox capacity without granting wakes. Result remains inspectable under bounded retention. Running tasks must first be stopped. An already queued notice may still arrive.",
    parameters: idSchema,
    execute: (_id, params) => runtime.dismiss(params.id),
  });
  pi.registerCommand("tasks", {
    description: "Inspect background tasks; pause/resume notifications or stop/dismiss a task",
    handler: (args, ctx) => runtime.command(args, ctx),
  });
  pi.registerMessageRenderer("background-tasks:wake", renderWake);
  pi.on("session_start", (_event, ctx) => runtime.startSession(ctx));
  pi.on("agent_start", (_event, ctx) => runtime.agentStart(ctx));
  pi.on("agent_settled", () => runtime.settled());
  pi.on("message_end", (event) => runtime.message(event));
  pi.on("context", (event, ctx) => runtime.context(event, ctx));
  pi.on("ui_prompt_start", () => runtime.prompt(true));
  pi.on("ui_prompt_end", () => runtime.prompt(false));
  pi.on("session_tree", (_event, ctx) => runtime.tree(ctx));
  pi.on("session_shutdown", () => runtime.shutdown());
}
