import { jsonText } from "@clanker-stuff/pi-tool-rendering/text";
/** Display-only snapshots: never consult live tasks or change the model-facing JSON. */
import { preview } from "@clanker-stuff/pi-tool-rendering/preview";
import { displayText as clean, inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { TUnsafe } from "typebox";
import type { TaskRuntime } from "./runtime.js";
import type { InspectInput, StartInput, taskRow } from "./task.js";
import type { taskSummary } from "./supervisor.js";

type CallArgs = Partial<StartInput & InspectInput>;

type Details = Awaited<ReturnType<TaskRuntime["start" | "list" | "inspect" | "stop"]>>["details"];

// Results persisted before tools carried typed details only have their text.
type Renderers = Required<
  Pick<ToolDefinition<TUnsafe<CallArgs>, Details | undefined>, "renderCall" | "renderResult">
>;

type TaskDisplay = ReturnType<typeof taskSummary | typeof taskRow>;

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

const taskLine = (task: TaskDisplay, theme: Theme) => {
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
    task.abandoned === true ? theme.fg("warning", "abandoned") : "",
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
          `${theme.fg("toolTitle", theme.bold(name))}${target ? ` ${theme.fg("accent", inline(target))}` : ""}${data.view ? theme.fg("muted", ` · ${inline(data.view)}`) : ""}`,
        ];

        if (name === "task_start" && data.command !== undefined) {
          const argv = data.args ?? [];

          // This is an executable + argv, not a shell command. Quote arguments to preserve boundaries.
          lines.push(theme.fg("toolOutput", [data.command, ...argv].map(jsonText).join(" ")));
        }

        if (context.expanded) {
          for (const key of [
            "cwd",
            "protocol",
            "timeoutMs",
            "eventId",
            "offset",
            "tailBytes",
          ] as const) {
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

    if (data === undefined) {
      add(() => theme.fg("toolOutput", clean(text)));

      return output;
    }

    // The warning itself is never collapsed, even when names or IDs consume the preview.
    const warn = (warning: string) =>
      output.addChild(preview(() => new Text(theme.fg("error", warning), 0, 0), true));

    if ("tasks" in data) {
      const failed = data.tasks.filter((item) => item.cleanup === "failed");
      const remaining = data.tasks.filter((item) => item.cleanup !== "failed");

      if (failed.length)
        warn(`Cleanup failed: ${failed.length} task${failed.length === 1 ? "" : "s"}`);

      add(() =>
        theme.fg("muted", `${data.tasks.length} tasks · ${data.pending} pending notifications`),
      );

      if (data.historyStorageError) add(() => theme.fg("error", str(data.historyStorageError)));

      for (const key of ["omittedProgress", "evictedEvents", "evictedTasks"] as const) {
        const count = data[key];

        if (count) add(() => theme.fg("warning", `${key}: ${count}`));
      }

      if (failed.length) add(() => failed.map((item) => taskLine(item, theme)).join("\n"));

      if (remaining.length) add(() => remaining.map((item) => taskLine(item, theme)).join("\n"), 8);
    } else if ("taskId" in data) {
      const payload = data.payload;
      add(() =>
        theme.fg(
          "muted",
          `${data.view} · ${inline(data.taskId)}${"eventId" in data ? ` · ${inline(data.eventId)}` : ""} · untrusted output`,
        ),
      );

      if ("reason" in data) add(() => theme.fg("muted", inline(data.reason)));

      if (payload !== undefined) {
        add(() => {
          const content = str(payload.text);

          try {
            // Pages may split JSON tokens; only highlight a self-contained value, never reserialize it.
            JSON.parse(content);

            return highlightCode(content, "json").join("\n");
          } catch {
            return theme.fg("toolOutput", content);
          }
        });
        add(() =>
          theme.fg("muted", `Byte offset ${payload.offset} · ${payload.totalBytes} bytes total`),
        );

        if (payload.nextOffset !== null)
          add(() =>
            theme.fg("warning", `More payload available · next offset ${payload.nextOffset}`),
          );
      } else add(() => theme.fg("muted", "No payload"));
    } else {
      const task = "task" in data ? data.task : data;

      if (task.cleanup === "failed") warn("Cleanup failed");

      add(() => taskLine(task, theme));

      if ("note" in data && options.expanded) add(() => theme.fg("muted", str(data.note)));

      if (options.expanded && "pid" in task) {
        add(() =>
          theme.fg(
            "muted",
            [
              task.pid !== undefined ? `PID ${task.pid}` : "",
              task.endedAt !== undefined
                ? `${((task.endedAt - task.startedAt) / 1000).toFixed(1)}s`
                : "",
              task.signal ? `signal ${inline(task.signal)}` : "",
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        );
      }

      if ("task" in data) {
        const { diagnostic, events, logs } = data;

        if (diagnostic) add(() => theme.fg("error", str(diagnostic)));

        add(() =>
          theme.fg(
            "muted",
            `${events.length} retained events · ${data.resultAvailable ? "result available" : "no result payload"}`,
          ),
        );

        if (options.expanded && events.length)
          add(() =>
            events.map((event) => `${inline(event.id)} · ${inline(event.reason)}`).join("\n"),
          );

        if (logs) {
          add(() => theme.fg("muted", "Logs · untrusted output"));

          if (logs.storageError) add(() => theme.fg("error", str(logs.storageError)));

          for (const stream of ["stdout", "stderr"] as const) {
            const omitted = logs[`${stream}OmittedBytes`];

            if (logs[stream] || omitted) {
              add(() =>
                theme.fg(
                  "muted",
                  `${stream}${omitted ? ` · ${omitted} earlier bytes omitted` : ""}`,
                ),
              );

              if (logs[stream]) add(() => theme.fg("toolOutput", str(logs[stream])), 5, true);
            }
          }

          if (logs.directory) add(() => theme.fg("muted", `Logs: ${inline(logs.directory)}`));
        }
      }
    }

    return output;
  },
});
