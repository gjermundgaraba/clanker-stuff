import { jsonText } from "@clanker-stuff/pi-tool-rendering/text";
/** Display-only snapshots: never consult live tasks or change the model-facing JSON. */
import { preview } from "@clanker-stuff/pi-tool-rendering/preview";
import { displayText as clean, inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

type Renderers = Required<Pick<ToolDefinition, "renderCall" | "renderResult">>;
type Data = Record<string, unknown>;
// SAFETY: Only non-null, non-array objects pass; all property values remain unknown.
const record = (value: unknown): Data =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {};
const str = (value: unknown) => (typeof value === "string" ? clean(value) : "");
const inline = (value: unknown) => (typeof value === "string" ? inlineText(value) : "");
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const status = (value: unknown, theme: Theme) => {
  const name = inline(value) || "unknown";
  if (name === "running") return theme.fg("warning", "● running");
  if (name === "completed" || name === "result")
    return theme.fg("success", `✓ ${name === "result" ? "result received" : name}`);
  if (name === "cancelled") return theme.fg("warning", "■ cancelled");
  return theme.fg("error", `✗ ${name.replaceAll("_", " ")}`);
};
const taskLine = (task: Data, theme: Theme) => {
  const exitCode = number(task.exitCode);
  return [
    status(task.status, theme),
    theme.fg("accent", inline(task.name) || inline(task.id)),
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
  renderCall(args, theme, context) {
    const data = record(args);
    return preview(
      () => {
        const target = name === "task_start" ? data.name : data.id;
        const lines = [
          `${theme.fg("toolTitle", theme.bold(name))}${target ? ` ${theme.fg("accent", inline(target))}` : ""}${data.view ? theme.fg("muted", ` · ${inline(data.view)}`) : ""}`,
        ];
        if (name === "task_start" && typeof data.command === "string") {
          const argv = Array.isArray(data.args)
            ? data.args.filter((arg): arg is string => typeof arg === "string")
            : [];
          // This is an executable + argv, not a shell command. Quote arguments to preserve boundaries.
          lines.push(theme.fg("toolOutput", [data.command, ...argv].map(jsonText).join(" ")));
        }
        if (context.expanded) {
          for (const key of ["cwd", "protocol", "timeoutMs", "eventId", "offset", "tailBytes"]) {
            const value = data[key];
            if (typeof value === "string" || typeof value === "number")
              lines.push(theme.fg("muted", `${key}: ${inline(String(value))}`));
          }
        }
        if (context.isPartial)
          lines.push(theme.fg("warning", context.executionStarted ? "● working" : "…"));
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
      add(() => theme.fg(context.isError ? "error" : "warning", clean(text) || "● working"));
      return output;
    }
    let data: Data;
    try {
      data = record(JSON.parse(text));
    } catch {
      data = {};
    }
    const tasks = Array.isArray(data.tasks) ? data.tasks.map(record) : undefined;
    const task = typeof data.id === "string" ? data : record(data.task);
    if (tasks) {
      add(() =>
        theme.fg(
          "muted",
          `${tasks.length} tasks · ${number(data.pending) ?? "?"} pending notifications`,
        ),
      );
      if (str(data.historyStorageError))
        add(() => theme.fg("error", str(data.historyStorageError)));
      for (const key of ["omittedProgress", "evictedEvents", "evictedTasks"]) {
        const count = number(data[key]);
        if (count) add(() => theme.fg("warning", `${key}: ${count}`));
      }
      const failed = tasks.filter((item) => item.cleanup === "failed");
      if (failed.length) {
        // The warning itself is never collapsed, even when names or IDs consume the preview.
        output.addChild(
          preview(
            () =>
              new Text(
                theme.fg(
                  "error",
                  `Cleanup failed: ${failed.length} task${failed.length === 1 ? "" : "s"}`,
                ),
                0,
                0,
              ),
            true,
          ),
        );
        add(() => failed.map((item) => taskLine(item, theme)).join("\n"));
      }
      const remaining = tasks.filter((item) => item.cleanup !== "failed");
      if (remaining.length) add(() => remaining.map((item) => taskLine(item, theme)).join("\n"), 8);
    } else if (typeof task.id === "string" && typeof task.status === "string") {
      if (task.cleanup === "failed")
        output.addChild(preview(() => new Text(theme.fg("error", "Cleanup failed"), 0, 0), true));
      add(() => taskLine(task, theme));
      if (name === "task_start" && options.expanded && str(data.note))
        add(() => theme.fg("muted", str(data.note)));
      if (str(data.diagnostic)) add(() => theme.fg("error", str(data.diagnostic)));
      if (options.expanded) {
        const pid = number(task.pid);
        const startedAt = number(task.startedAt);
        const endedAt = number(task.endedAt);
        add(() =>
          [
            pid !== undefined ? `PID ${pid}` : "",
            endedAt !== undefined && startedAt !== undefined
              ? `${((endedAt - startedAt) / 1000).toFixed(1)}s`
              : "",
            task.signal ? `signal ${inline(task.signal)}` : "",
          ]
            .filter(Boolean)
            .map((line) => theme.fg("muted", line))
            .join(" · "),
        );
      }
      if (Array.isArray(data.events)) {
        const events = data.events.map(record);
        add(() =>
          theme.fg(
            "muted",
            `${events.length} retained events · ${data.resultAvailable === true ? "result available" : "no result payload"}`,
          ),
        );
        if (options.expanded && events.length)
          add(() =>
            events.map((event) => `${inline(event.id)} · ${inline(event.reason)}`).join("\n"),
          );
      }
      const logs = record(data.logs);
      if (Object.keys(logs).length) {
        add(() => theme.fg("muted", "Logs · untrusted output"));
        if (str(logs.storageError)) add(() => theme.fg("error", str(logs.storageError)));
        for (const stream of ["stdout", "stderr"]) {
          const omitted = number(logs[`${stream}OmittedBytes`]);
          if (str(logs[stream]) || omitted) {
            add(() =>
              theme.fg("muted", `${stream}${omitted ? ` · ${omitted} earlier bytes omitted` : ""}`),
            );
            if (str(logs[stream])) add(() => theme.fg("toolOutput", str(logs[stream])), 5, true);
          }
        }
        if (str(logs.directory)) add(() => theme.fg("muted", `Logs: ${inline(logs.directory)}`));
      }
    } else if (
      typeof data.taskId === "string" &&
      (data.view === "event" || data.view === "result")
    ) {
      const payload = record(data.payload);
      add(() =>
        theme.fg(
          "muted",
          `${inline(data.view)} · ${inline(data.taskId)}${data.eventId ? ` · ${inline(data.eventId)}` : ""} · untrusted output`,
        ),
      );
      if (str(data.reason)) add(() => theme.fg("muted", inline(data.reason)));
      if (typeof payload.text === "string") {
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
          theme.fg(
            "muted",
            `Byte offset ${number(payload.offset) ?? "?"} · ${number(payload.totalBytes) ?? "?"} bytes total`,
          ),
        );
        const nextOffset = number(payload.nextOffset);
        if (nextOffset !== undefined)
          add(() => theme.fg("warning", `More payload available · next offset ${nextOffset}`));
      } else add(() => theme.fg("muted", "No payload"));
    } else add(() => theme.fg("toolOutput", clean(text)));
    return output;
  },
});
