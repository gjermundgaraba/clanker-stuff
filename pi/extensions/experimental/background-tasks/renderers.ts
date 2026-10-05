/** Display-only snapshots: never consult live tasks or change the model-facing JSON. */
import { preview } from "@clanker-stuff/pi-tool-rendering/preview";
import { displayText as clean, inlineText, jsonText } from "@clanker-stuff/pi-tool-rendering/text";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { TUnsafe } from "typebox";
import { Value } from "typebox/value";
import { toolOutputSchema, type ListRow, type TaskSummary } from "./output.js";
import type { InspectInput, StartInput } from "./task.js";

type CallArgs = Partial<StartInput & InspectInput>;

// Persisted results can predate the current schema; unsupported details use their stored text.
type Renderers = Required<
  Pick<ToolDefinition<TUnsafe<CallArgs>, unknown>, "renderCall" | "renderResult">
>;

const str = (value: string | null | undefined) => clean(value ?? "");

const inline = (value: string | null | undefined) => inlineText(value ?? "");

const status = (value: string, theme: Theme) => {
  const name = inline(value) || "unknown";

  if (name === "running") return theme.fg("accent", "● running");

  if (name === "completed" || name === "result")
    return theme.fg("success", `✓ ${name === "result" ? "result received" : name}`);

  if (name === "cancelled") return theme.fg("muted", "■ cancelled");

  return theme.fg("error", `✗ ${name.replaceAll("_", " ")}`);
};

const taskLine = (task: TaskSummary | ListRow, theme: Theme) => {
  const exitCode = "exitCode" in task ? (task.exitCode ?? undefined) : undefined;

  return [
    status(task.status, theme),
    theme.fg("text", inline(task.name) || inline(task.id)),
    task.name ? theme.fg("muted", inline(task.id)) : "",
    exitCode !== undefined ? theme.fg("muted", `exit ${exitCode}`) : "",
    task.cleanup === "failed" ? theme.fg("error", "cleanup failed") : "",
    task.cleanup === "pending" && task.status !== "running"
      ? theme.fg("warning", "cleanup pending")
      : "",
    "unread" in task && task.unread ? theme.fg("warning", "unread") : "",
  ]
    .filter(Boolean)
    .join(" · ");
};

export const taskRenderers = (name: string): Renderers => ({
  renderCall(data, theme, context) {
    return preview(
      () => {
        const target = name === "task_start" ? data.name : data.id;

        const lines = [
          `${theme.fg("toolTitle", theme.bold(name))}${target ? ` ${theme.fg("accent", inline(target))}` : ""}`,
        ];

        if (name === "task_start" && data.command !== undefined) {
          const argv = data.args ?? [];

          // This is an executable + argv, not a shell command. Quote arguments to preserve boundaries.
          lines.push(theme.fg("toolOutput", [data.command, ...argv].map(jsonText).join(" ")));
        }

        if (context.expanded) {
          for (const key of ["cwd", "protocol", "timeoutMs", "tailBytes"] as const) {
            const value = data[key];

            if (value !== undefined)
              lines.push(theme.fg("muted", `${key}: ${inline(String(value))}`));
          }
        }

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

    const add = (draw: () => string, limit = 5, tail = false) =>
      output.addChild(
        preview(() => new Text(draw(), 0, 0), options.expanded, limit, tail ? "tail" : "head"),
      );

    if (context.isError || options.isPartial) {
      add(() => theme.fg(context.isError ? "error" : "accent", clean(text) || "● working"));

      return output;
    }

    const data = result.details;

    if (!Value.Check(toolOutputSchema, data)) {
      add(() => theme.fg("toolOutput", clean(text)));

      return output;
    }

    // The warning itself is never collapsed, even when names or IDs consume the preview.
    const warn = (warning: string) =>
      output.addChild(preview(() => new Text(theme.fg("error", warning), 0, 0), true));

    if ("tasks" in data) {
      const failed = data.tasks.filter((item) => item.cleanup === "failed");
      const remaining = data.tasks.filter((item) => item.cleanup !== "failed");
      const unread = data.tasks.filter((item) => item.unread).length;

      if (failed.length)
        warn(`Cleanup failed: ${failed.length} task${failed.length === 1 ? "" : "s"}`);

      add(() => theme.fg("muted", `${data.tasks.length} tasks · ${unread} unread`));

      if (failed.length) add(() => failed.map((item) => taskLine(item, theme)).join("\n"));

      if (remaining.length) add(() => remaining.map((item) => taskLine(item, theme)).join("\n"), 8);

      return output;
    }

    const task = "task" in data ? data.task : data;

    if (task.cleanup === "failed") warn("Cleanup failed");

    add(() => taskLine(task, theme));

    if (options.expanded) {
      const metadata = [
        task.pid !== undefined ? `PID ${task.pid}` : "",
        task.endedAt !== undefined ? `${((task.endedAt - task.startedAt) / 1000).toFixed(1)}s` : "",
        task.signal ? `signal ${inline(task.signal)}` : "",
      ]
        .filter(Boolean)
        .join(" · ");

      if (metadata) add(() => theme.fg("muted", metadata));
    }

    if (!("task" in data)) return output;
    const { diagnostic, events, logs } = data;

    if (diagnostic) add(() => theme.fg("error", str(diagnostic)));

    if ("result" in data) {
      add(() => theme.fg("muted", "Result · untrusted output"));
      add(() => highlightCode(jsonText(data.result), "json").join("\n"));
    }

    if (events.length || data.omittedEvents) {
      add(() =>
        theme.fg(
          "muted",
          `${events.length} retained events${data.omittedEvents ? ` · ${data.omittedEvents} earlier omitted` : ""} · untrusted output`,
        ),
      );

      if (options.expanded && events.length)
        add(() =>
          events
            .map(
              (event) =>
                `#${event.seq}${event.key === undefined ? "" : ` ${inline(event.key)}`} ${inline(jsonText(event.data))}`,
            )
            .join("\n"),
        );
    }

    for (const stream of ["stdout", "stderr"] as const) {
      const omitted = logs[`${stream}OmittedBytes`];

      if (logs[stream] || omitted) {
        add(() =>
          theme.fg(
            "muted",
            `${stream} · untrusted output${omitted ? ` · ${omitted} earlier bytes omitted` : ""}`,
          ),
        );

        if (logs[stream]) add(() => theme.fg("toolOutput", str(logs[stream])), 5, true);
      }
    }

    return output;
  },
});
