import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  codeBlockComponent,
  displayedProcessOutput,
  formatCodeBlock,
  inlineText,
  parseProcessDetails,
  PrefixedComponent,
  sanitizeDisplayText,
} from "../tools/renderers.js";
import type { Unparsed } from "../tools/renderers.js";

import { codeModeOutput } from "./output-display.js";
import type { NestedTool, RuntimeToolTrace, RuntimeValue } from "./types.js";
import { RuntimeToolTraceSchema } from "./types.js";

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

const SCRIPT_PREVIEW_ROWS = 3;
const COLLAPSED_RESULT_ROWS = 16;
const COLLAPSED_TRACE_COUNT = 4;
const COLLAPSED_TRACE_ROWS = 10;
const OUTPUT_PREVIEW_ROWS = 5;
const PRAGMA_LINE = /^[ \t]*\/\/ @exec:(?<options>[^\r\n]*)$/u;

interface TraceRendererState {
  state: ToolRenderContext["state"];
  call?: Component;
  result?: Component;
}

type ShellTone = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

interface CodeModeRenderState {
  hasTraces?: boolean;
  hasResult?: boolean;
  tone?: ShellTone;
  action?: "Exec" | "Wait" | "Terminate";
  nested?: Map<string, TraceRendererState>;
}

type RenderContext = Omit<ToolRenderContext, "state"> & { state: CodeModeRenderState };
const ExecArgsSchema = Type.Object({ code: Type.Optional(Type.String()) });
const WaitArgsSchema = Type.Object({
  cell_id: Type.Optional(Type.String()),
  terminate: Type.Optional(Type.Boolean()),
});
type Outcome = "done" | "running" | "error";

const SHELL_PADDING_X = 1;

const shellRow = (line: string, width: number, paint: (text: string) => string): string =>
  paint(`${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`);

/**
 * Pi's default shell colors the whole row by the outer result, so a completed script would give
 * its failed nested commands a green success background. Code Mode draws the same box itself and
 * takes the color from the worst nested outcome instead. The call and result components share one
 * box: whichever is visible first draws the top padding row and the last one draws the bottom.
 */
export const renderCodeModeShell = (
  inner: Component,
  role: "call" | "result",
  theme: Theme,
  context: RenderContext,
): Component => ({
  invalidate() {
    inner.invalidate();
  },
  render(width) {
    const lines = inner.render(Math.max(1, width - SHELL_PADDING_X * 2));
    if (lines.length === 0) return [];
    const paint = (text: string) => theme.bg(context.state.tone ?? "toolPendingBg", text);
    const callVisible = context.expanded || context.state.hasTraces !== true;
    const top = role === "call" || !callVisible;
    const bottom = role === "result" || context.state.hasResult !== true;
    const pad = " ".repeat(SHELL_PADDING_X);
    return [
      ...(top ? [shellRow("", width, paint)] : []),
      ...lines.map((line) => shellRow(`${pad}${line}`, width, paint)),
      ...(bottom ? [shellRow("", width, paint)] : []),
    ];
  },
});

const textContent = (result: Pick<AgentToolResult<RuntimeValue>, "content">): string =>
  result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");

const traceOutcome = (trace: RuntimeToolTrace): Outcome => {
  const process = parseProcessDetails(trace.result?.details);
  if (
    trace.status === "error" ||
    Boolean(trace.error) ||
    process?.status === "killed" ||
    (process?.status === "exited" && process.exitCode !== 0)
  ) {
    return "error";
  }
  if (process?.status === "running" || (trace.status === "running" && process === undefined)) {
    return "running";
  }
  return "done";
};

const traceOutcomes = (traces: RuntimeToolTrace[]): Map<string, Outcome> => {
  const sessions = new Map<number, string>();
  for (const trace of traces) {
    const process = parseProcessDetails(trace.result?.details);
    const input = trace.input;
    const polledSession =
      trace.name === "write_stdin" &&
      typeof input === "object" &&
      input !== null &&
      "session_id" in input &&
      typeof input.session_id === "number"
        ? input.session_id
        : undefined;
    const session = polledSession ?? process?.sessionId;
    if (session !== undefined && process !== undefined) {
      // Concurrent polls complete out of invocation order; a process never runs again after exiting.
      const known = sessions.get(session);
      if (known === undefined || process.status !== "running")
        sessions.set(session, process.status);
    }
  }
  return new Map(
    traces.map((trace) => {
      const process = parseProcessDetails(trace.result?.details);
      const latest = process?.sessionId === undefined ? undefined : sessions.get(process.sessionId);
      // An earlier yielded process is historical once a later poll observes its exit.
      // The final poll owns its exit status; do not count one failure twice.
      const settled = process?.status === "running" && latest !== undefined && latest !== "running";
      return [trace.id, settled && trace.status === "done" ? "done" : traceOutcome(trace)];
    }),
  );
};

/** `outcomes` is built from the same trace list every caller draws from, so every ID is present. */
const displayedOutcome = (trace: RuntimeToolTrace, outcomes: Map<string, Outcome>): Outcome => {
  const outcome = outcomes.get(trace.id);
  if (outcome === undefined) throw new Error(`No outcome resolved for trace ${trace.id}`);
  return outcome;
};

const outcomeColor = (outcome: Outcome) =>
  outcome === "error" ? "error" : outcome === "running" ? "warning" : "success";

const outcomeGlyph = (outcome: Outcome): string =>
  outcome === "error" ? "✗" : outcome === "running" ? "●" : "✓";

const formatExecCall = (args: Unparsed, theme: Theme): string => {
  const title = theme.fg("toolTitle", theme.bold("Exec"));
  if (!Value.Check(ExecArgsSchema, args)) return `${title} ${theme.fg("error", "[invalid arg]")}`;
  const code = args.code;
  if (code === undefined) return `${title} ${theme.fg("muted", "…")}`;
  const lines = code.split("\n");
  const pragma = PRAGMA_LINE.exec(lines[0] ?? "")?.groups?.options?.trim();
  const source = pragma === undefined ? code : lines.slice(1).join("\n");
  const header =
    pragma === undefined
      ? title
      : `${title} ${theme.fg("muted", `@exec ${sanitizeDisplayText(pragma)}`)}`;
  return source.trim().length === 0
    ? header
    : [header, ...formatCodeBlock(source, "javascript").map((line) => `  ${line}`)].join("\n");
};

export const renderExecCall = (args: Unparsed, theme: Theme, context: RenderContext): Component => {
  context.state.action = "Exec";
  return {
    invalidate() {},
    render(width) {
      // Pi creates the call component before the result component. Read shared state at
      // draw time so the first completed frame already replaces the wrapper with its calls.
      if (!context.expanded && context.state.hasTraces) return [];
      return codeBlockComponent(
        formatExecCall(args, theme),
        theme,
        context.expanded,
        SCRIPT_PREVIEW_ROWS + 1,
      ).render(width);
    },
  };
};

export const renderWaitCall = (args: Unparsed, theme: Theme, context: RenderContext): Component => {
  const valid = Value.Check(WaitArgsSchema, args);
  const action = valid && args.terminate === true ? "Terminate" : "Wait";
  context.state.action = action;
  const title = theme.fg("toolTitle", theme.bold(action));
  const cell = valid ? args.cell_id : undefined;
  const text = !valid
    ? `${title} ${theme.fg("error", "[invalid arg]")}`
    : cell === undefined
      ? title
      : `${title} ${theme.fg("muted", inlineText(cell))}`;
  return {
    invalidate() {},
    render(width) {
      return !context.expanded && context.state.hasTraces
        ? []
        : [truncateToWidth(text, width, "…")];
    },
  };
};

const traceRenderers = (
  trace: RuntimeToolTrace,
  nested: NestedTool | undefined,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext,
) => {
  const states = (context.state.nested ??= new Map());
  let slots = states.get(trace.id);
  if (slots === undefined) {
    slots = { state: {} };
    states.set(trace.id, slots);
  }
  // Traces keep the raw freeform string that Code Mode passed; renderers expect the same object
  // shape execution builds before validation.
  const args =
    nested?.freeformProperty !== undefined && typeof trace.input === "string"
      ? { [nested.freeformProperty]: trace.input }
      : trace.input;
  const nestedContext: ToolRenderContext = {
    ...context,
    args,
    argsComplete: true,
    // These are snapshots of delegated calls. The outer tool owns live execution;
    // nested renderers must not start another pending timer for this historical row.
    executionStarted: false,
    expanded: options.expanded,
    isError: trace.status === "error",
    isPartial: trace.status === "running",
    lastComponent: slots.call,
    state: slots.state,
    toolCallId: trace.id,
  };
  let call: Component;
  try {
    call =
      nested?.definition.renderCall?.(args, theme, nestedContext) ??
      new Text(theme.fg("toolTitle", trace.name), 0, 0);
  } catch {
    call = new Text(theme.fg("toolTitle", trace.name), 0, 0);
  }
  slots.call = call;
  let result: Component | undefined;
  if (trace.result !== undefined && nested?.definition.renderResult) {
    try {
      result = nested.definition.renderResult(
        { content: trace.result.content, details: trace.result.details },
        { expanded: options.expanded, isPartial: trace.status === "running" },
        theme,
        { ...nestedContext, lastComponent: slots.result },
      );
    } catch {
      // Preserve the captured output if a third-party renderer cannot display this trace.
    }
  }
  slots.result = result;
  return { call, result };
};

const traceOutput = (trace: RuntimeToolTrace): string => {
  if (trace.error) return sanitizeDisplayText(trace.error);
  if (trace.result === undefined) return "";
  const text = textContent(trace.result);
  const process = parseProcessDetails(trace.result.details);
  return process === undefined ? sanitizeDisplayText(text) : displayedProcessOutput(text, process);
};

const traceSuffix = (trace: RuntimeToolTrace, outcome: Outcome): string => {
  const process = parseProcessDetails(trace.result?.details);
  if (process === undefined) return outcome === "running" ? "running" : "";
  const duration = `${(process.durationMs / 1000).toFixed(1)}s`;
  if (process.status === "running")
    return `${outcome === "running" ? "running" : "yielded"} · ${duration}`;
  if (process.status === "killed") return `killed · ${duration}`;
  return process.exitCode === 0 ? duration : `exit ${process.exitCode ?? "unknown"} · ${duration}`;
};

const compactTraceRow = (
  trace: RuntimeToolTrace,
  call: Component,
  theme: Theme,
  width: number,
  outcome: Outcome,
): string => {
  const prefix = `  ${theme.fg(outcomeColor(outcome), outcomeGlyph(outcome))} `;
  const suffixText = traceSuffix(trace, outcome);
  const suffix = suffixText.length === 0 ? "" : `  ${theme.fg("muted", suffixText)}`;
  const available = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
  const lines = call.render(available);
  const first = lines[0]?.trimEnd() ?? trace.name;
  const preview =
    lines.length > 1
      ? `${truncateToWidth(first, Math.max(0, available - 1), "")}…`
      : truncateToWidth(first, available, "…");
  const padding = " ".repeat(Math.max(0, available - visibleWidth(preview)));
  return truncateToWidth(`${prefix}${preview}${padding}${suffix}`, width, "…");
};

const selectTraces = (
  traces: RuntimeToolTrace[],
  outcomes: Map<string, Outcome>,
): RuntimeToolTrace[] => {
  const priority = (trace: RuntimeToolTrace) =>
    displayedOutcome(trace, outcomes) === "error"
      ? 0
      : displayedOutcome(trace, outcomes) === "running"
        ? 1
        : 2;
  const chosen = new Set(
    traces
      .map((trace, index) => ({ trace, index }))
      .toSorted((a, b) => priority(a.trace) - priority(b.trace) || b.index - a.index)
      .slice(0, COLLAPSED_TRACE_COUNT)
      .map(({ trace }) => trace.id),
  );
  return traces.filter((trace) => chosen.has(trace.id));
};

const resultStatus = (
  status: RuntimeValue,
  scriptError: boolean,
  traces: RuntimeToolTrace[],
  theme: Theme,
  outcomes: Map<string, Outcome>,
): string => {
  const failed = traces.filter((trace) => displayedOutcome(trace, outcomes) === "error").length;
  const running = traces.filter((trace) => displayedOutcome(trace, outcomes) === "running").length;
  if (scriptError) return theme.fg("error", "✗ error");
  if (status === "terminated") return theme.fg("warning", "■ terminated");
  if (failed > 0) {
    const active = status === "running" || status === "yielded" || running > 0;
    return theme.fg("error", `${failed} failed${active ? " · running" : ""}`);
  }
  if (status === "running" || running > 0) return theme.fg("warning", "● running");
  if (status === "yielded") return theme.fg("warning", "◌ running");
  return theme.fg("success", "✓ completed");
};

const countLabel = (traces: RuntimeToolTrace[]): string => {
  const noun = traces.every((trace) => trace.name === "exec_command") ? "command" : "call";
  return `${traces.length} ${noun}${traces.length === 1 ? "" : "s"}`;
};

export const renderCodeModeResult = (
  result: AgentToolResult<RuntimeValue>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext,
  tools: Map<string, NestedTool>,
): Component => {
  const details =
    typeof result.details === "object" && result.details !== null ? result.details : {};
  const tracesValue = "traces" in details ? details.traces : undefined;
  const traces = Array.isArray(tracesValue)
    ? tracesValue.filter((value): value is RuntimeToolTrace =>
        Value.Check(RuntimeToolTraceSchema, value),
      )
    : [];
  context.state.hasTraces = traces.length > 0;
  const retainedIds = new Set(traces.map((trace) => trace.id));
  for (const id of context.state.nested?.keys() ?? []) {
    if (!retainedIds.has(id)) context.state.nested?.delete(id);
  }
  const scriptError =
    "scriptError" in details && typeof details.scriptError === "string" ? details.scriptError : "";
  const status = "status" in details ? details.status : undefined;
  const dropped =
    "droppedTraceCount" in details && typeof details.droppedTraceCount === "number"
      ? details.droppedTraceCount
      : 0;
  const outcomes = traceOutcomes(traces);
  const failed = traces.some((trace) => displayedOutcome(trace, outcomes) === "error");
  context.state.hasResult = true;
  context.state.tone = options.isPartial
    ? "toolPendingBg"
    : context.isError || scriptError.length > 0 || failed
      ? "toolErrorBg"
      : "toolSuccessBg";
  const summary = resultStatus(
    status,
    context.isError || scriptError.length > 0,
    traces,
    theme,
    outcomes,
  );
  const heading =
    traces.length === 0
      ? summary
      : `${theme.fg("toolTitle", theme.bold(options.expanded ? "Results" : (context.state.action ?? "Exec")))} ${theme.fg("muted", `· ${countLabel(traces)} ·`)} ${summary}`;
  const errors = context.isError
    ? sanitizeDisplayText(textContent(result))
    : sanitizeDisplayText(scriptError);
  const outputs = context.isError
    ? []
    : codeModeOutput(result.content.slice(1), traces, theme, options.expanded);

  if (options.expanded) {
    const container = new Container();
    container.addChild(new Text(heading, 0, 0));
    if (errors.length > 0) container.addChild(new Text(theme.fg("error", errors), 0, 0));
    for (const trace of traces) {
      const rendered = traceRenderers(trace, tools.get(trace.name), options, theme, context);
      const outcome = displayedOutcome(trace, outcomes);
      const glyph = theme.fg(outcomeColor(outcome), outcomeGlyph(outcome));
      container.addChild(new PrefixedComponent(rendered.call, `  ${glyph} `, "    "));
      if (rendered.result !== undefined) {
        container.addChild(new PrefixedComponent(rendered.result, "    ", "    "));
      } else {
        const output = traceOutput(trace);
        if (output) container.addChild(new Text(theme.fg("toolOutput", output), 4, 0));
      }
      if (trace.error && rendered.result !== undefined) {
        container.addChild(new Text(theme.fg("error", sanitizeDisplayText(trace.error)), 4, 0));
      }
    }
    if (dropped > 0)
      container.addChild(new Text(theme.fg("muted", `… ${dropped} calls not traced`), 0, 0));
    if (outputs.length > 0) {
      container.addChild(
        new Text(
          `\n${theme.fg("muted", "Script output")}\n${outputs.map((item) => item.text).join("\n")}`,
          0,
          0,
        ),
      );
    }
    return container;
  }

  const selected = selectTraces(traces, outcomes);
  const calls = selected.map((trace) => ({
    trace,
    ...traceRenderers(trace, tools.get(trace.name), options, theme, context),
  }));
  const hidden = traces.filter((trace) => !selected.includes(trace));
  return {
    invalidate() {
      for (const call of calls) call.call.invalidate();
    },
    render(width) {
      const rows = [truncateToWidth(heading, width, "…")];
      const inlineOutputIds = new Set<string>();
      let errorsHidden = false;
      if (errors.length > 0) {
        const errorRows = new Text(theme.fg("error", errors), 0, 0).render(width);
        rows.push(...errorRows.slice(0, 3));
        errorsHidden = errorRows.length > 3;
      }
      let previewBudget = Math.max(0, COLLAPSED_TRACE_ROWS - calls.length - (rows.length - 1));
      for (const { trace, call } of calls) {
        const outcome = displayedOutcome(trace, outcomes);
        rows.push(compactTraceRow(trace, call, theme, width, outcome));
        if (outcome !== "error" || previewBudget === 0) continue;
        // The returned envelope is complete; the trace copy may have been truncated head-first.
        const text = outputs.find((item) => item.traceId === trace.id)?.plain ?? traceOutput(trace);
        if (text.length === 0) continue;
        const preview = truncateToVisualLines(
          theme.fg("error", text),
          Math.min(3, previewBudget),
          Math.max(1, width - 4),
        );
        rows.push(...preview.visualLines.map((line) => truncateToWidth(`    ${line}`, width, "…")));
        previewBudget -= preview.visualLines.length;
        inlineOutputIds.add(trace.id);
      }
      const output = outputs
        .filter((item) => item.traceId === undefined || !inlineOutputIds.has(item.traceId))
        .map((item) => item.text)
        .join("\n");
      const outputBudget = Math.min(OUTPUT_PREVIEW_ROWS, COLLAPSED_RESULT_ROWS - rows.length - 2);
      let outputHidden = false;
      if (output.length > 0 && outputBudget > 0) {
        const preview = truncateToVisualLines(output, outputBudget, width);
        rows.push("", ...preview.visualLines);
        outputHidden = preview.skippedCount > 0;
      } else if (output.length > 0) outputHidden = true;
      const notes: string[] = [];
      if (hidden.length > 0) {
        notes.push(`${hidden.length} more calls`);
        const failed = hidden.filter(
          (trace) => displayedOutcome(trace, outcomes) === "error",
        ).length;
        const running = hidden.filter(
          (trace) => displayedOutcome(trace, outcomes) === "running",
        ).length;
        if (failed > 0) notes.push(`${failed} failed`);
        if (running > 0) notes.push(`${running} running`);
      }
      if (dropped > 0) notes.push(`${dropped} calls not traced`);
      if (traces.length > 0 || outputHidden || errorsHidden) {
        const label = notes.length > 0 ? `${notes.join(" · ")} · ` : "";
        rows.push(
          truncateToWidth(
            `${theme.fg("muted", `… ${label}`)}${keyHint("app.tools.expand", "details")}`,
            width,
            "…",
          ),
        );
      }
      return rows;
    },
  };
};
