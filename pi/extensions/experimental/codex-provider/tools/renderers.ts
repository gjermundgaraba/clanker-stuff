/**
 * Presentation for the Codex direct tools.
 *
 * Renderers live apart from the execution modules so a display-only process never loads the
 * process manager, patch application, or their typebox schemas. `direct.ts` spreads these into the
 * tool definitions, and Code Mode reuses them for nested tool traces.
 */
import { homedir } from "node:os";
import { preview } from "@clanker-stuff/pi-tool-rendering/preview";
import { displayText, inlineText, jsonText } from "@clanker-stuff/pi-tool-rendering/text";

import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { formatSize, highlightCode, renderDiff } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { TRACE_VALUE_TRUNCATED_MARKER } from "../code-mode/trace-values.js";

import type { PatchChange } from "./patch-summary.js";
import { PatchChangeSchema, PatchDiffSchema, summarizePatchText } from "./patch-summary.js";
import { lazyComponent } from "./render-components.js";
import { formatProcessMetadata } from "./process-metadata.js";

export const COMMAND_PREVIEW_LINES = 3;
export const OUTPUT_PREVIEW_LINES = 5;
export const DIFF_PREVIEW_LINES = 12;
export const PATCH_FILE_PREVIEW_ROWS = 8;
export const STDIN_PREVIEW_LINES = 3;

type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
type Renderers = Required<Pick<ToolDefinition, "renderCall" | "renderResult">>;
type ToolResult = AgentToolResult<unknown>;
type ResultLike = Pick<ToolResult, "content">;

/** Tool arguments and details arrive from the session as opaque values and are parsed here. */

const ExecCommandArgsSchema = Type.Object({
  cmd: Type.Optional(Type.String()),
  workdir: Type.Optional(Type.String()),
});
const WriteStdinArgsSchema = Type.Object({
  chars: Type.Optional(Type.String()),
  session_id: Type.Optional(Type.Integer()),
});
const ApplyPatchArgsSchema = Type.Object({ patch: Type.Optional(Type.String()) });
const ViewImageArgsSchema = Type.Object({ path: Type.Optional(Type.String()) });

const ProcessDisplayDetailsSchema = Type.Object({
  durationMs: Type.Number(),
  exitCode: Type.Union([Type.Number(), Type.Null()]),
  fullOutputPath: Type.Optional(Type.String()),
  requestedBudgetTruncation: Type.Optional(Type.Object({ originalTokenCount: Type.Number() })),
  sessionId: Type.Optional(Type.Number()),
  status: Type.Union([Type.Literal("exited"), Type.Literal("killed"), Type.Literal("running")]),
  truncation: Type.Optional(
    Type.Object({
      maxBytes: Type.Optional(Type.Number()),
      outputLines: Type.Number(),
      totalLines: Type.Number(),
      truncated: Type.Boolean(),
      truncatedBy: Type.Optional(
        Type.Union([Type.Literal("bytes"), Type.Literal("lines"), Type.Null()]),
      ),
    }),
  ),
});
export type ProcessDisplayDetails = Static<typeof ProcessDisplayDetailsSchema>;

const ApplyPatchDetailsSchema = Type.Object({ changes: Type.Array(Type.Unknown()) });
const UnknownArraySchema = Type.Array(Type.Unknown());

interface PatchDetails {
  entries: { change: PatchChange; diff?: string }[];
  /** False when the trace bound reached the change list itself, so the list is not authoritative. */
  complete: boolean;
}

/** The change list and the diffs are validated independently: a cut in one must not hide the other. */
const parsePatchDetails = (details: unknown): PatchDetails | undefined => {
  if (!Value.Check(ApplyPatchDetailsSchema, details)) return undefined;
  const diffs = new Map<number, string>();
  const rawDiffs = "diffs" in details ? details.diffs : undefined;
  for (const entry of Value.Check(UnknownArraySchema, rawDiffs) ? rawDiffs : []) {
    if (Value.Check(PatchDiffSchema, entry)) diffs.set(entry.index, entry.diff);
  }
  const entries = details.changes.flatMap((change, index) =>
    Value.Check(PatchChangeSchema, change) ? [{ change, diff: diffs.get(index) }] : [],
  );
  return { entries, complete: entries.length === details.changes.length };
};

const BUDGET_TRUNCATION_HEADER =
  /^Warning: truncated output \(original token count: \d+\)\nTotal output lines: \d+\n\n/u;

const textOf = (result: ResultLike): string =>
  result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");

export const shortenPath = (path: string): string => {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
};

const formatDuration = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** Indentation grows with nesting, so deep or dense values keep their original layout instead. */
const JSON_FORMAT_MAX_DEPTH = 32;
const JSON_FORMAT_GROWTH_LIMIT = 8;

/**
 * Re-indents valid JSON text without parsing it into JavaScript values, so numbers beyond the
 * safe-integer range, duplicate keys, and exact literals survive the display.
 */
export const formatJsonText = (text: string): string => {
  const maxOutput = text.length * JSON_FORMAT_GROWTH_LIMIT;
  const indent = (depth: number) => "\n" + "  ".repeat(depth);
  const nonSpaceAfter = (index: number): string | undefined =>
    /[^\s]/u.exec(text.slice(index + 1))?.[0];
  let output = "";
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (inString) {
      output += char;
      if (char === "\\") {
        index += 1;
        output += text[index] ?? "";
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "{" || char === "[") {
      const close = char === "{" ? "}" : "]";
      if (nonSpaceAfter(index) === close) {
        output += `${char}${close}`;
        index = text.indexOf(close, index + 1);
      } else {
        depth += 1;
        if (depth > JSON_FORMAT_MAX_DEPTH) return text;
        output += `${char}${indent(depth)}`;
      }
    } else if (char === "}" || char === "]") {
      depth = Math.max(0, depth - 1);
      output += `${indent(depth)}${char}`;
    } else if (char === ",") {
      output += `,${indent(depth)}`;
    } else if (char === ":") {
      output += ": ";
    } else if (!/\s/u.test(char)) {
      output += char;
    }
    if (output.length > maxOutput) return text;
  }
  return output;
};

/** Pretty-prints and highlights JSON objects or arrays; other text keeps the plain output color. */
export const highlightJsonIfPossible = (text: string, theme: Theme): string => {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      // Parsing only validates the text; the displayed tokens come from the original string.
      JSON.parse(trimmed);
      return highlightCode(formatJsonText(trimmed), "json").join("\n");
    } catch {
      // Not JSON; fall through to plain output.
    }
  }
  return text
    .split("\n")
    .map((line) => theme.fg("toolOutput", line))
    .join("\n");
};

/** Prefixes every rendered line, using a distinct marker on the first line. */
export class PrefixedComponent implements Component {
  constructor(
    private readonly child: Component,
    private readonly firstPrefix: string,
    private readonly restPrefix: string,
  ) {}

  invalidate(): void {
    this.child.invalidate?.();
  }

  render(width: number): string[] {
    const prefixWidth = Math.max(visibleWidth(this.firstPrefix), visibleWidth(this.restPrefix));
    const innerWidth = Math.max(1, width - prefixWidth);
    return this.child
      .render(innerWidth)
      .map((line, index) =>
        truncateToWidth(`${index === 0 ? this.firstPrefix : this.restPrefix}${line}`, width, ""),
      );
  }
}

/** Highlights source and returns its styled lines; collapsing happens per screen row in components. */
export const formatCodeBlock = (source: string, language: string): string[] =>
  highlightCode(displayText(source), language);

const invalidArgs = (title: string, theme: Theme): string =>
  `${title} ${theme.fg("error", "[invalid arg]")}`;

const formatExecCommandCall = (args: unknown, theme: Theme): string => {
  const prompt = theme.fg("toolTitle", theme.bold("$"));
  if (!Value.Check(ExecCommandArgsSchema, args)) {
    return invalidArgs(prompt, theme);
  }
  if (args.cmd === undefined) {
    return `${prompt} ${theme.fg("toolOutput", "...")}`;
  }
  const [first = "", ...rest] = formatCodeBlock(args.cmd, "bash");
  const workdir =
    args.workdir !== undefined && args.workdir.length > 0
      ? theme.fg("muted", ` (in ${inlineText(shortenPath(args.workdir))})`)
      : "";
  return [`${prompt} ${first}${workdir}`, ...rest.map((line) => `  ${line}`)].join("\n");
};

const formatWriteStdinCall = (args: unknown, theme: Theme): string => {
  const label = theme.fg("toolTitle", theme.bold("stdin"));
  if (!Value.Check(WriteStdinArgsSchema, args)) {
    return invalidArgs(label, theme);
  }
  const session = args.session_id === undefined ? "session …" : `session ${args.session_id}`;
  const title = `${label} ${theme.fg("accent", session)}`;
  const chars = args.chars ?? "";
  if (chars.length === 0) {
    return `${title} ${theme.fg("muted", "(poll)")}`;
  }
  // Serialize before escaping display controls so the original stdin value is preserved.
  const escaped = jsonText(chars).slice(1, -1);
  return `${title} ${theme.fg("muted", "←")} ${theme.fg("toolOutput", escaped)}`;
};

export const parseProcessDetails = (details: unknown): ProcessDisplayDetails | undefined =>
  Value.Check(ProcessDisplayDetailsSchema, details) ? details : undefined;

/** Removes the model-facing trailer and budget warning so only real process output is displayed. */
export const displayedProcessOutput = (text: string, details: ProcessDisplayDetails): string => {
  const metadata = formatProcessMetadata(details);
  let output = text;
  if (output === metadata) {
    output = "";
  } else if (output.endsWith(`\n\n${metadata}`)) {
    output = output.slice(0, -metadata.length - 2);
  }
  if (details.requestedBudgetTruncation !== undefined) {
    output = output.replace(BUDGET_TRUNCATION_HEADER, "");
  }
  return displayText(output);
};

export const formatProcessStatus = (details: ProcessDisplayDetails, theme: Theme): string => {
  const duration = theme.fg("muted", ` · ${formatDuration(details.durationMs)}`);
  if (details.status === "running") {
    const session =
      details.sessionId === undefined ? "" : theme.fg("muted", ` · session ${details.sessionId}`);
    return `${theme.fg("warning", "● running")}${session}${duration}`;
  }
  if (details.status === "killed") {
    return `${theme.fg("error", "■ killed")}${duration}`;
  }
  if (details.exitCode === 0) {
    return `${theme.fg("success", "✓ exit 0")}${duration}`;
  }
  return `${theme.fg("error", `✗ exit ${details.exitCode ?? "unknown"}`)}${duration}`;
};

const formatProcessWarnings = (details: ProcessDisplayDetails): string[] => {
  const warnings: string[] = [];
  if (details.fullOutputPath !== undefined) {
    warnings.push(`Full output: ${inlineText(details.fullOutputPath)}`);
  }
  const { truncation } = details;
  // Output is rebuilt from the full file whenever both fields are present, so the capture
  // buffer's line truncation does not describe the displayed text of older persisted results.
  if (truncation?.truncated === true && details.fullOutputPath === undefined) {
    warnings.push(
      truncation.truncatedBy === "lines"
        ? `Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`
        : `Truncated: ${truncation.outputLines} lines shown${truncation.maxBytes === undefined ? "" : ` (${formatSize(truncation.maxBytes)} limit)`}`,
    );
  }
  if (details.requestedBudgetTruncation !== undefined) {
    warnings.push(
      `Model view capped: ~${details.requestedBudgetTruncation.originalTokenCount.toLocaleString("en-US")} tokens total`,
    );
  }
  return warnings;
};

const errorComponent = (result: ResultLike, theme: Theme): Component => {
  const text = displayText(textOf(result));
  return preview(() => new Text(text.length > 0 ? `\n${theme.fg("error", text)}` : "", 0, 0), true);
};

/** Builds the output block shared by every process-backed result. */
export const renderProcessResult = (
  result: ResultLike,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: Pick<RenderContext, "isError">,
  details: ProcessDisplayDetails | undefined,
): Component =>
  lazyComponent(() => {
    if (context.isError) {
      return errorComponent(result, theme);
    }
    const container = new Container();
    if (details === undefined) {
      const text = displayText(textOf(result));
      if (text.length > 0) {
        container.addChild(new Text(`\n${theme.fg("toolOutput", text)}`, 0, 0));
      }
      return container;
    }
    const output = displayedProcessOutput(textOf(result), details);
    if (output.length > 0) {
      // Keep spacing outside the bounded output, and rebuild colors on theme invalidation.
      container.addChild(new Spacer(1));
      container.addChild(
        preview(
          () => new Text(theme.fg("toolOutput", output), 0, 0),
          options.expanded,
          OUTPUT_PREVIEW_LINES,
          "tail",
        ),
      );
    } else if (details.status !== "running") {
      container.addChild(new Text(`\n${theme.fg("muted", "(no output)")}`, 0, 0));
    }
    const warnings = formatProcessWarnings(details);
    if (warnings.length > 0) {
      container.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
    }
    container.addChild(new Text(`\n${formatProcessStatus(details, theme)}`, 0, 0));
    return container;
  });

interface ProcessCallState {
  interval?: ReturnType<typeof setInterval>;
  startedAt?: number;
  drawnAt?: number;
}

/** A pending row that has not been drawn for this long has left the transcript. */
const PENDING_TICK_MS = 1000;
const DETACHED_AFTER_MS = PENDING_TICK_MS * 3;

const clearPendingTimer = (state: ProcessCallState): void => {
  if (state.interval !== undefined) {
    clearInterval(state.interval);
    state.interval = undefined;
  }
};

/**
 * Pi rebuilds the transcript when display settings change and keeps no dispose hook for the
 * replaced rows, so the timer stops itself once its row is no longer drawn. A live row is drawn
 * on every tick because the tick invalidates it.
 */
const armPendingTimer = (context: RenderContext, state: ProcessCallState): void => {
  state.interval ??= setInterval(() => {
    if (Date.now() - (state.drawnAt ?? state.startedAt ?? 0) > DETACHED_AFTER_MS) {
      clearPendingTimer(state);
      return;
    }
    context.invalidate();
  }, PENDING_TICK_MS);
};

const trackPendingProcess = (context: RenderContext): string => {
  // SAFETY: Row-local state is owned by this renderer pair; no other slot writes to it.
  const state = context.state as ProcessCallState;
  if (context.isPartial && context.executionStarted) {
    state.startedAt ??= Date.now();
    armPendingTimer(context, state);
    return formatDuration(Date.now() - state.startedAt);
  }
  clearPendingTimer(state);
  return "";
};

const pendingLine = (context: RenderContext, theme: Theme): string => {
  const elapsed = trackPendingProcess(context);
  return elapsed.length > 0
    ? `\n${theme.fg("warning", "● running")}${theme.fg("muted", ` · ${elapsed}`)}`
    : "";
};

/** Builds a call row and records each draw so the pending timer can tell a detached row apart. */
const processCallComponent = (
  formatted: () => string,
  previewLines: number,
  theme: Theme,
  context: RenderContext,
): Component => {
  const container = new Container();
  container.addChild(preview(() => new Text(formatted(), 0, 0), context.expanded, previewLines));
  const pending = pendingLine(context, theme);
  if (pending.length > 0) {
    container.addChild(new Text(pending, 0, 0));
  }
  // SAFETY: Row-local state is owned by this renderer pair; no other slot writes to it.
  const state = context.state as ProcessCallState;
  return {
    invalidate() {
      container.invalidate();
    },
    render(width) {
      state.drawnAt = Date.now();
      // Pi stops drawing while an external editor runs; a live row drawn again re-arms the timer.
      if (context.isPartial && context.executionStarted) armPendingTimer(context, state);
      return container.render(width);
    },
  };
};

const processResultRenderer: NonNullable<ToolDefinition["renderResult"]> = (
  result,
  options,
  theme,
  context,
) => renderProcessResult(result, options, theme, context, parseProcessDetails(result.details));

export const execCommandRenderers: Renderers = {
  renderCall(args, theme, context) {
    return processCallComponent(
      () => formatExecCommandCall(args, theme),
      COMMAND_PREVIEW_LINES,
      theme,
      context,
    );
  },
  renderResult: processResultRenderer,
};

export const writeStdinRenderers: Renderers = {
  renderCall(args, theme, context) {
    return processCallComponent(
      () => formatWriteStdinCall(args, theme),
      STDIN_PREVIEW_LINES,
      theme,
      context,
    );
  },
  renderResult: processResultRenderer,
};

const formatLineCounts = (added: number, removed: number, theme: Theme): string =>
  `${theme.fg("muted", "(")}${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `-${removed}`)}${theme.fg("muted", ")")}`;

const patchVerb = { add: "Add", delete: "Delete", update: "Update" } as const;
const patchMarker = { add: "A", delete: "D", update: "M" } as const;

const formatPatchPath = (change: Pick<PatchChange, "from" | "path">, theme: Theme): string =>
  change.from === undefined
    ? theme.fg("accent", inlineText(change.path))
    : `${theme.fg("accent", inlineText(change.from))} ${theme.fg("muted", "→")} ${theme.fg("accent", inlineText(change.path))}`;

/** Unknown or zero counts show nothing: an unreadable deletion, or a pure rename. */
const formatPatchCounts = (change: PatchChange, theme: Theme): string =>
  change.lines === undefined || (change.lines.added === 0 && change.lines.removed === 0)
    ? ""
    : ` ${formatLineCounts(change.lines.added, change.lines.removed, theme)}`;

interface PatchCallState {
  /** Completed changes from the result metadata; replaces the text summary once known. */
  completed?: PatchChange[];
}

interface PatchSummary {
  changes: PatchChange[];
  /** True when the arguments are a bounded trace copy, so files and counts may be missing. */
  partial: boolean;
}

/**
 * A nested Code Mode trace keeps a bounded copy of the arguments, so a header built from that
 * text may be missing files and shows a low count for the file that was cut. The cut file's counts
 * are withheld and the file count is marked open-ended until the completed result arrives.
 */
const summarizePatchArgs = (patch: string): PatchSummary => {
  const changes = summarizePatchText(patch);
  const partial = patch.endsWith(TRACE_VALUE_TRUNCATED_MARKER);
  const last = changes.at(-1);
  if (partial && last !== undefined) {
    delete last.lines;
  }
  return { changes, partial };
};

const formatApplyPatchCall = (args: unknown, theme: Theme, state: PatchCallState): string => {
  const title = theme.fg("toolTitle", theme.bold("apply_patch"));
  if (!Value.Check(ApplyPatchArgsSchema, args)) {
    return invalidArgs(title, theme);
  }
  const { changes, partial } =
    state.completed === undefined
      ? summarizePatchArgs(args.patch ?? "")
      : { changes: state.completed, partial: false };
  const [single] = changes;
  if (single === undefined) {
    return `${title} ${theme.fg("toolOutput", "...")}`;
  }
  const open = partial ? theme.fg("muted", " …") : "";
  if (changes.length === 1) {
    const verb = theme.fg("muted", patchVerb[single.kind]);
    return `${title} ${verb} ${formatPatchPath(single, theme)}${formatPatchCounts(single, theme)}${open}`;
  }
  // Totals need every count: a pending deletion's is unknown until the result arrives, and an
  // unreadable deletion's stays unknown.
  const known = changes.flatMap((change) => (change.lines === undefined ? [] : [change.lines]));
  const total = known.reduce<NonNullable<PatchChange["lines"]>>(
    (sum, lines) => ({ added: sum.added + lines.added, removed: sum.removed + lines.removed }),
    { added: 0, removed: 0 },
  );
  const totals =
    state.completed !== undefined &&
    known.length === changes.length &&
    (total.added > 0 || total.removed > 0)
      ? ` ${formatLineCounts(total.added, total.removed, theme)}`
      : "";
  return [
    `${title} ${theme.fg("muted", `${changes.length}${partial ? "+" : ""} files`)}${totals}`,
    ...changes.map(
      (change) =>
        `  ${theme.fg("muted", patchMarker[change.kind])} ${formatPatchPath(change, theme)}${formatPatchCounts(change, theme)}`,
    ),
  ].join("\n");
};

/**
 * Lists every completed change from the result metadata. A nested Code Mode header is built from
 * a bounded copy of the arguments, so a change whose diff was cut would otherwise vanish from a
 * large patch entirely. A lone change repeats its name only when there is more to say than a diff.
 */
const formatApplyPatchResult = (details: PatchDetails, theme: Theme): string => {
  const single = details.complete && details.entries.length === 1;
  const lines: string[] = [];
  details.entries.forEach(({ change, diff }) => {
    const path = formatPatchPath(change, theme);
    if (diff !== undefined) {
      if (!single) lines.push(path);
      lines.push(...renderDiff(displayText(diff)).split("\n"));
    } else if (change.changed) {
      lines.push(
        single
          ? theme.fg("muted", "(diff omitted)")
          : `${path} ${theme.fg("muted", "(diff omitted)")}`,
      );
    } else if (change.from === undefined) {
      lines.push(
        single ? theme.fg("muted", "(unchanged)") : `${path} ${theme.fg("muted", "(unchanged)")}`,
      );
    } else if (!single) {
      lines.push(path);
    }
  });
  if (!details.complete) {
    lines.push(theme.fg("muted", "… further changes not recorded"));
  }
  return lines.join("\n");
};

export const applyPatchRenderers: Renderers = {
  renderCall(args, theme, context) {
    // Pi invokes renderCall before renderResult; defer formatting until the component is
    // rendered so the completed result can supply the header on the first draw.
    // SAFETY: This renderer pair owns the row-local patch state.
    const state = context.state as PatchCallState;
    return preview(
      () => new Text(formatApplyPatchCall(args, theme, state), 0, 0),
      context.expanded,
      PATCH_FILE_PREVIEW_ROWS + 1,
    );
  },
  renderResult(result, options, theme, context) {
    // SAFETY: This renderer pair owns the row-local patch state.
    const state = context.state as PatchCallState;
    state.completed = undefined;
    if (context.isError) {
      return errorComponent(result, theme);
    }
    const details = parsePatchDetails(result.details);
    const container = new Container();
    if (details === undefined) {
      return container;
    }
    if (!options.isPartial && details.complete) {
      state.completed = details.entries.map(({ change }) => change);
    }
    container.addChild(
      preview(
        () => new Text(formatApplyPatchResult(details, theme), 0, 0),
        options.expanded,
        DIFF_PREVIEW_LINES,
      ),
    );
    return container;
  },
};

export const viewImageRenderers: Renderers = {
  renderCall(args, theme, context) {
    const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    const title = theme.fg("toolTitle", theme.bold("view_image"));
    if (!Value.Check(ViewImageArgsSchema, args)) {
      text.setText(invalidArgs(title, theme));
      return text;
    }
    text.setText(
      `${title} ${
        args.path === undefined
          ? theme.fg("toolOutput", "...")
          : theme.fg("accent", inlineText(shortenPath(args.path)))
      }`,
    );
    return text;
  },
  renderResult(result, options, theme, context) {
    if (context.isError) {
      return errorComponent(result, theme);
    }
    const note = displayText(textOf(result));
    if (note.length === 0 || !options.expanded) {
      return new Container();
    }
    return new Text(`\n${theme.fg("muted", note)}`, 0, 0);
  },
};
