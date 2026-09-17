/** Presentation only. V1/V2 wire results and persisted controller state remain untouched. */
import { preview } from "@clanker-stuff/pi-tool-rendering/preview";
import { displayText as clean, inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

type Data = Record<string, unknown>;
type Renderers = Required<Pick<ToolDefinition, "renderCall" | "renderResult">>;
// SAFETY: Only non-null, non-array objects pass; all property values remain unknown.
const record = (value: unknown): Data =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {};
const str = (value: unknown) => (typeof value === "string" ? clean(value) : "");
const inline = (value: unknown) => (typeof value === "string" ? inlineText(value) : "");

const status = (value: unknown, theme: Theme): string => {
  if (typeof value === "string") {
    const label = inline(value).replaceAll("_", " ");
    if (value === "running" || value === "pending_init") return theme.fg("accent", `● ${label}`);
    if (value === "not_found") return theme.fg("error", `✗ ${label}`);
    return theme.fg("muted", `■ ${label}`);
  }
  const data = record(value);
  if (typeof data.completed === "string" || data.completed === null)
    return theme.fg("success", "✓ completed");
  if (typeof data.errored === "string") return theme.fg("error", "✗ errored");
  return theme.fg("muted", "unknown status");
};
const inputText = (args: Data): string => {
  if (typeof args.message === "string") return str(args.message);
  if (!Array.isArray(args.items)) return "";
  return args.items
    .map(record)
    .map((item) => {
      if (item.type === "text") return str(item.text);
      if (item.type === "skill") return `[skill: ${inline(item.name)}]`;
      if (item.type === "local_image") return `[image: ${inline(item.path)}]`;
      // Never dump base64 image data into a transcript header.
      return `[${inline(item.type) || "input item"}]`;
    })
    .join("\n");
};

export const agentRenderers = (name: string): Renderers => ({
  renderCall(args, theme, context) {
    const data = record(args);
    return preview(
      () => {
        const target = data.task_name ?? data.target ?? data.id ?? data.path_prefix;
        const targets = Array.isArray(data.targets) ? data.targets.map(inline).join(", ") : "";
        const heading = `${theme.fg("toolTitle", theme.bold(name))}${target || targets ? ` ${theme.fg("accent", inline(target) || targets)}` : ""}`;
        const lines = [heading];
        const settings = [
          data.agent_type ? `role ${inline(data.agent_type)}` : "",
          data.model ? inline(data.model) : "",
          data.reasoning_effort ? inline(data.reasoning_effort) : "",
          data.interrupt === true ? "interrupt" : "",
        ].filter(Boolean);
        if (settings.length) lines.push(theme.fg("muted", settings.join(" · ")));
        if (context.expanded) {
          if (typeof data.fork_turns === "string")
            lines.push(theme.fg("muted", `history: ${inline(data.fork_turns)}`));
          if (typeof data.fork_context === "boolean")
            lines.push(theme.fg("muted", `fork context: ${data.fork_context}`));
          if (typeof data.timeout_ms === "number")
            lines.push(theme.fg("muted", `timeout: ${data.timeout_ms / 1000}s`));
        }
        const message = inputText(data);
        if (message) lines.push(theme.fg("toolOutput", message));
        if (context.isPartial)
          lines.push(theme.fg("accent", context.executionStarted ? "● working" : "…"));
        return new Text(lines.join("\n"), 0, 0);
      },
      context.expanded,
      3,
    );
  },
  renderResult(result, options, theme, context) {
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    const output = new Container();
    const add = (draw: () => string, limit = 5) =>
      output.addChild(preview(() => new Text(draw(), 0, 0), options.expanded, limit));
    if (context.isError || options.isPartial) {
      add(() => theme.fg(context.isError ? "error" : "accent", clean(text) || "● working"));
      return output;
    }
    if (!text && (name === "send_message" || name === "followup_task")) {
      add(() =>
        theme.fg("success", name === "send_message" ? "✓ Message queued" : "✓ Follow-up submitted"),
      );
      return output;
    }
    let data: Data;
    try {
      data = record(JSON.parse(text));
    } catch {
      data = {};
    }
    const addStatus = (value: unknown, target = "", prefix = "") => {
      add(
        () =>
          `${prefix ? theme.fg("muted", prefix) : ""}${target ? `${theme.fg("accent", inline(target))} · ` : ""}${status(value, theme)}`,
      );
      const detail = record(value);
      const answer = str(detail.errored) || str(detail.completed);
      if (answer) add(() => theme.fg(detail.errored ? "error" : "toolOutput", answer));
    };
    if (
      name === "spawn_agent" &&
      (typeof data.agent_id === "string" || typeof data.task_name === "string")
    ) {
      const details = record(result.details);
      const nickname = inline(data.nickname) || inline(details.nickname);
      add(
        () =>
          `${theme.fg("success", "✓ Spawned")} ${theme.fg("accent", inline(data.task_name) || inline(data.agent_id))}${nickname ? theme.fg("muted", ` · ${nickname}`) : ""}`,
      );
    } else if (typeof data.submission_id === "string") {
      add(
        () =>
          `${theme.fg("success", "✓ Input submitted")} ${theme.fg("muted", inline(data.submission_id))}`,
      );
    } else if ("previous_status" in data) {
      // Do not imply the previous status is the target's current state or claim a missing target was stopped.
      addStatus(data.previous_status, "", "Previous status · ");
    } else if (name === "resume_agent" && "status" in data) {
      addStatus(data.status);
    } else if (name === "wait_agent" && typeof data.timed_out === "boolean") {
      add(() =>
        theme.fg(
          data.timed_out ? "muted" : "success",
          data.timed_out ? "Wait timed out" : "✓ Activity received",
        ),
      );
      if (typeof data.message === "string") add(() => theme.fg("toolOutput", str(data.message)));
      for (const [target, value] of Object.entries(record(data.status))) addStatus(value, target);
    } else if (Array.isArray(data.agents)) {
      const agents = data.agents.map(record);
      add(() => theme.fg("muted", `${agents.length} resident agents`));
      if (options.expanded) {
        for (const agent of agents) addStatus(agent.agent_status, str(agent.agent_name));
      } else {
        // Bound the whole summary list; expanded rows include each agent's details exactly once.
        add(
          () =>
            agents
              .map(
                (agent) =>
                  `${theme.fg("accent", inline(agent.agent_name))} · ${status(agent.agent_status, theme)}`,
              )
              .join("\n"),
          8,
        );
      }
    } else add(() => theme.fg("toolOutput", clean(text)));
    return output;
  },
});
