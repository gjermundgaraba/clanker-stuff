import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  BashToolInput,
  EditToolInput,
  ExtensionContext,
  FindToolInput,
  GrepToolInput,
  LsToolInput,
  ReadToolInput,
  WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLocalBashOperations,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DEFAULT_MAX_BYTES,
  truncateHead,
  truncateLine,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

import { resolvePath } from "./path.js";

type ReplacementInput = Pick<EditToolInput, "path"> &
  EditToolInput["edits"][number] & { replaceAll?: boolean };
type GrepInput = GrepToolInput & {
  afterContext?: number;
  beforeContext?: number;
  multiline?: boolean;
  outputMode?: "content" | "count" | "files_with_matches";
};
type ShellInput = Pick<BashToolInput, "command"> & {
  cwd?: string;
  timeoutMs?: number;
};
type WriteInput = WriteToolInput & { mode?: "append" | "overwrite" };

interface OperationContext {
  ctx: ExtensionContext;
  onUpdate?: AgentToolUpdateCallback<unknown>;
  signal?: AbortSignal;
  toolCallId: string;
}

export type OperationResult = AgentToolResult<unknown>;

const textResult = (text: string, details: unknown = {}) => ({
  content: [{ text, type: "text" as const }],
  details,
});

const throwIfAborted = (signal: AbortSignal | undefined) => {
  if (signal?.aborted === true) {
    throw new Error("Operation aborted");
  }
};

interface ExecutableDefinition<TParams, TDetails> {
  readonly execute: (
    toolCallId: string,
    params: TParams,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext
  ) => Promise<AgentToolResult<TDetails>>;
}

const runDefinition = async <TParams, TDetails>(
  definition: ExecutableDefinition<TParams, TDetails>,
  params: NoInfer<TParams>,
  execution: OperationContext
): Promise<OperationResult> =>
  await definition.execute(
    execution.toolCallId,
    params,
    execution.signal,
    execution.onUpdate,
    execution.ctx
  );

const shellQuote = (value: string) =>
  `'${value.replaceAll("'", String.raw`'"'"'`)}'`;

const createGrepArguments = (input: GrepInput, searchPath: string) => {
  const args = ["--line-number", "--color=never", "--hidden"];
  if (input.outputMode === "count") {
    args.push("--count", "--with-filename");
  } else if (input.outputMode === "files_with_matches") {
    args.push("--files-with-matches");
  } else {
    args.push("--json");
  }
  if (input.ignoreCase === true) {
    args.push("--ignore-case");
  }
  if (input.multiline === true) {
    args.push("--multiline");
  }
  if (input.context !== undefined && input.context > 0) {
    args.push("--context", String(input.context));
  }
  if (input.afterContext !== undefined && input.afterContext >= 0) {
    args.push("--after-context", String(input.afterContext));
  }
  if (input.beforeContext !== undefined && input.beforeContext >= 0) {
    args.push("--before-context", String(input.beforeContext));
  }
  if (input.glob !== undefined && input.glob.length > 0) {
    args.push("--glob", input.glob);
  }
  args.push("--", input.pattern, searchPath);
  return args;
};

const formatGrepPath = (line: string, searchPath: string) => {
  if (line === searchPath) {
    return path.basename(searchPath);
  }
  if (line.startsWith(`${searchPath}${path.sep}`)) {
    return line.slice(searchPath.length + 1);
  }
  if (line.startsWith(`${searchPath}:`)) {
    return `${path.basename(searchPath)}${line.slice(searchPath.length)}`;
  }
  if (line.startsWith(`${searchPath}-`)) {
    return `${path.basename(searchPath)}${line.slice(searchPath.length)}`;
  }
  return line;
};

interface RgContentEvent {
  filePath: string;
  lineNumber: number;
  lines: string[];
  type: "context" | "match";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const decodeRgText = (value: Record<string, unknown>) => {
  if (typeof value.text === "string") {
    return value.text;
  }
  return typeof value.bytes === "string"
    ? Buffer.from(value.bytes, "base64").toString("utf-8")
    : undefined;
};

const parseGrepContent = (output: string): RgContentEvent[] =>
  output.split("\n").flatMap((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    if (
      !isRecord(parsed) ||
      !(parsed.type === "context" || parsed.type === "match") ||
      !isRecord(parsed.data) ||
      !isRecord(parsed.data.path) ||
      !isRecord(parsed.data.lines)
    ) {
      return [];
    }
    const { line_number: lineNumber } = parsed.data;
    const filePath = decodeRgText(parsed.data.path);
    const text = decodeRgText(parsed.data.lines);
    if (
      typeof filePath !== "string" ||
      typeof lineNumber !== "number" ||
      typeof text !== "string"
    ) {
      return [];
    }
    const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    return [
      {
        filePath,
        lineNumber,
        lines: (normalized.endsWith("\n")
          ? normalized.slice(0, -1)
          : normalized
        ).split("\n"),
        type: parsed.type,
      },
    ];
  });

const renderGrepContent = (
  events: readonly RgContentEvent[],
  limit: number,
  beforeContext: number,
  afterContext: number,
  searchPath: string
) => {
  const matches = events.filter((event) => event.type === "match");
  const selected = new Set(matches.slice(0, limit));
  const unselected = new Set(matches.slice(limit));
  const intervals = new Map<string, { end: number; start: number }[]>();
  for (const event of selected) {
    const ranges = intervals.get(event.filePath) ?? [];
    ranges.push({
      end: event.lineNumber + event.lines.length - 1 + afterContext,
      start: Math.max(1, event.lineNumber - beforeContext),
    });
    intervals.set(event.filePath, ranges);
  }

  const output: string[] = [];
  const seen = new Set<string>();
  let linesTruncated = false;
  let previous: { filePath: string; lineNumber: number } | undefined;
  for (const event of events) {
    const ranges = intervals.get(event.filePath) ?? [];
    for (const [offset, text] of event.lines.entries()) {
      const lineNumber = event.lineNumber + offset;
      if (
        unselected.has(event) ||
        !ranges.some(
          (range) => lineNumber >= range.start && lineNumber <= range.end
        )
      ) {
        continue;
      }
      const key = `${event.filePath}\0${lineNumber}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (
        previous !== undefined &&
        (previous.filePath !== event.filePath ||
          previous.lineNumber + 1 !== lineNumber)
      ) {
        output.push("--");
      }
      const marker = selected.has(event) ? ":" : "-";
      const truncated = truncateLine(text);
      linesTruncated ||= truncated.wasTruncated;
      output.push(
        `${formatGrepPath(event.filePath, searchPath)}${marker}${lineNumber}${marker}${truncated.text}`
      );
      previous = { filePath: event.filePath, lineNumber };
    }
  }
  return {
    limitReached: matches.length > limit,
    linesTruncated,
    output: output.join("\n"),
  };
};

const executeGrep = async (command: string, execution: OperationContext) => {
  const controller = new AbortController();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let outputLimitReached = false;
  const abort = () => {
    controller.abort();
  };
  throwIfAborted(execution.signal);
  execution.signal?.addEventListener("abort", abort, { once: true });

  let exitCode: number | null = null;
  try {
    ({ exitCode } = await createLocalBashOperations().exec(
      command,
      execution.ctx.cwd,
      {
        onData: (data) => {
          if (outputLimitReached) {
            return;
          }
          const remaining = DEFAULT_MAX_BYTES * 2 - bytes;
          if (remaining <= 0) {
            outputLimitReached = true;
            controller.abort();
            return;
          }
          const retained =
            data.length > remaining
              ? Buffer.from(data.subarray(0, remaining))
              : data;
          chunks.push(retained);
          bytes += retained.length;
          if (retained.length < data.length) {
            outputLimitReached = true;
            controller.abort();
          }
        },
        signal: controller.signal,
        timeout: 30,
      }
    ));
  } catch (error) {
    throwIfAborted(execution.signal);
    if (!outputLimitReached) {
      throw error;
    }
  } finally {
    execution.signal?.removeEventListener("abort", abort);
  }
  let output = Buffer.concat(chunks);
  if (outputLimitReached) {
    output = output.subarray(0, output.lastIndexOf(0x0a) + 1);
  }
  return {
    exitCode,
    output: output.toString("utf-8"),
    outputLimitReached,
  };
};

const renderNativeGrep = (
  input: GrepInput,
  output: string,
  limit: number,
  searchPath: string
) => {
  if ((input.outputMode ?? "content") === "content") {
    return renderGrepContent(
      parseGrepContent(output),
      limit,
      input.beforeContext ?? input.context ?? 0,
      input.afterContext ?? input.context ?? 0,
      searchPath
    );
  }
  const entries = output.trimEnd()
    ? output
        .trimEnd()
        .split("\n")
        .map((line) => formatGrepPath(line, searchPath))
    : [];
  return {
    limitReached: entries.length > limit,
    linesTruncated: false,
    output: entries.slice(0, limit).join("\n"),
  };
};

const grepWithNativeOptions = async (
  input: GrepInput,
  execution: OperationContext
): Promise<OperationResult> => {
  const searchPath = resolvePath(input.path ?? ".", execution.ctx.cwd);
  const limit = Math.max(1, input.limit ?? 100);
  const args = createGrepArguments(input, searchPath);
  const { exitCode, output, outputLimitReached } = await executeGrep(
    ["rg", ...args].map(shellQuote).join(" "),
    execution
  );
  throwIfAborted(execution.signal);
  if (!outputLimitReached && exitCode !== 0 && exitCode !== 1) {
    throw new Error(output.trim() || `ripgrep exited with code ${exitCode}`);
  }

  const rendered = renderNativeGrep(input, output, limit, searchPath);
  const truncation = truncateHead(rendered.output);
  const notices = [
    rendered.limitReached ? `${limit} matches limit reached` : undefined,
    outputLimitReached || truncation.truncated
      ? "Output byte limit reached"
      : undefined,
    rendered.linesTruncated
      ? "Some lines truncated; use the read tool to see full lines"
      : undefined,
  ].filter((notice): notice is string => notice !== undefined);
  const content = `${truncation.content}${
    notices.length > 0 ? `\n\n[${notices.join(". ")}]` : ""
  }`;
  return textResult(content || "No matches found", {
    ...(rendered.limitReached ? { matchLimitReached: limit } : {}),
    ...(rendered.linesTruncated ? { linesTruncated: true } : {}),
    ...(truncation.truncated ? { truncation } : {}),
  });
};

export const toolOperations = {
  async findFiles(
    input: FindToolInput,
    execution: OperationContext
  ): Promise<OperationResult> {
    return await runDefinition(
      createFindToolDefinition(execution.ctx.cwd),
      input,
      execution
    );
  },

  async grep(
    input: GrepInput,
    execution: OperationContext
  ): Promise<OperationResult> {
    const afterContext = input.afterContext ?? input.context ?? 0;
    const beforeContext = input.beforeContext ?? input.context ?? 0;
    if (
      afterContext > 0 ||
      afterContext !== beforeContext ||
      input.afterContext !== undefined ||
      input.beforeContext !== undefined ||
      input.multiline === true ||
      (input.outputMode ?? "content") !== "content"
    ) {
      return await grepWithNativeOptions(input, execution);
    }
    const {
      afterContext: _afterContext,
      beforeContext: _beforeContext,
      ...grepInput
    } = input;
    return await runDefinition(
      createGrepToolDefinition(execution.ctx.cwd),
      { ...grepInput, context: afterContext || undefined },
      execution
    );
  },

  async list(
    input: LsToolInput,
    execution: OperationContext
  ): Promise<OperationResult> {
    return await runDefinition(
      createLsToolDefinition(execution.ctx.cwd),
      input,
      execution
    );
  },

  async read(
    input: ReadToolInput,
    execution: OperationContext
  ): Promise<OperationResult> {
    return await runDefinition(
      createReadToolDefinition(execution.ctx.cwd),
      input,
      execution
    );
  },

  async replace(
    input: ReplacementInput,
    execution: OperationContext
  ): Promise<OperationResult> {
    if (input.replaceAll === true) {
      if (input.oldText.length === 0) {
        throw new Error("old_string must not be empty");
      }
      const absolutePath = resolvePath(input.path, execution.ctx.cwd);
      return await withFileMutationQueue(absolutePath, async () => {
        throwIfAborted(execution.signal);
        const content = await readFile(absolutePath, "utf-8");
        throwIfAborted(execution.signal);
        if (!content.includes(input.oldText)) {
          throw new Error(`Could not find old_string in ${input.path}`);
        }
        const replacementCount = content.split(input.oldText).length - 1;
        const updated = content.replaceAll(input.oldText, input.newText);
        if (updated === content) {
          throw new Error(`Replacement made no changes in ${input.path}`);
        }
        await writeFile(absolutePath, updated, "utf-8");
        return textResult(
          `Successfully replaced all occurrences in ${input.path}.`,
          { replacementCount }
        );
      });
    }
    return await runDefinition(
      createEditToolDefinition(execution.ctx.cwd),
      {
        edits: [{ newText: input.newText, oldText: input.oldText }],
        path: input.path,
      },
      execution
    );
  },

  async runShell(
    input: ShellInput,
    execution: OperationContext
  ): Promise<OperationResult> {
    return await runDefinition(
      createBashToolDefinition(
        input.cwd === undefined
          ? execution.ctx.cwd
          : resolvePath(input.cwd, execution.ctx.cwd)
      ),
      {
        command: input.command,
        timeout:
          input.timeoutMs === undefined ? undefined : input.timeoutMs / 1000,
      },
      execution
    );
  },

  async write(
    input: WriteInput,
    execution: OperationContext
  ): Promise<OperationResult> {
    if (input.mode === "append") {
      const absolutePath = resolvePath(input.path, execution.ctx.cwd);
      return await withFileMutationQueue(absolutePath, async () => {
        throwIfAborted(execution.signal);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        throwIfAborted(execution.signal);
        await appendFile(absolutePath, input.content, "utf-8");
        return textResult(`Successfully appended to ${input.path}.`, {
          bytes: Buffer.byteLength(input.content),
          mode: "append",
        });
      });
    }
    return await runDefinition(
      createWriteToolDefinition(execution.ctx.cwd),
      { content: input.content, path: input.path },
      execution
    );
  },
};

export type ToolOperations = typeof toolOperations;
