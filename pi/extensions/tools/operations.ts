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
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

import { resolvePath } from "./path.js";

type ReplacementInput = Pick<EditToolInput, "path"> &
  EditToolInput["edits"][number] & { replaceAll?: boolean };
type GrepInput = GrepToolInput & {
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

const createGrepArguments = (
  input: GrepInput,
  limit: number,
  searchPath: string
) => {
  const args = ["--line-number", "--color=never", "--hidden"];
  if (input.outputMode === "count") {
    args.push("--count");
  } else if (input.outputMode === "files_with_matches") {
    args.push("--files-with-matches");
  } else {
    args.push("--with-filename");
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
  if (input.glob !== undefined && input.glob.length > 0) {
    args.push("--glob", input.glob);
  }
  args.push("--max-count", String(limit), "--", input.pattern, searchPath);
  return args;
};

const formatGrepPath = (line: string, searchPath: string) => {
  if (line.startsWith(`${searchPath}${path.sep}`)) {
    return line.slice(searchPath.length + 1);
  }
  if (line.startsWith(`${searchPath}:`)) {
    return `${path.basename(searchPath)}${line.slice(searchPath.length)}`;
  }
  return line;
};

const executeGrep = async (
  command: string,
  limit: number,
  execution: OperationContext
) => {
  const controller = new AbortController();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let lines = 0;
  let limitReached = false;
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
          if (limitReached || outputLimitReached) {
            return;
          }
          chunks.push(data);
          bytes += data.length;
          for (const byte of data) {
            if (byte === 0x0a) {
              lines += 1;
            }
          }
          limitReached = lines > limit;
          outputLimitReached = bytes > DEFAULT_MAX_BYTES * 2;
          if (limitReached || outputLimitReached) {
            controller.abort();
          }
        },
        signal: controller.signal,
        timeout: 30,
      }
    ));
  } catch (error) {
    throwIfAborted(execution.signal);
    if (!(limitReached || outputLimitReached)) {
      throw error;
    }
  } finally {
    execution.signal?.removeEventListener("abort", abort);
  }
  return {
    exitCode,
    limitReached,
    output: Buffer.concat(chunks).toString("utf-8"),
    outputLimitReached,
  };
};

const grepWithNativeOptions = async (
  input: GrepInput,
  execution: OperationContext
): Promise<OperationResult> => {
  const searchPath = resolvePath(input.path ?? ".", execution.ctx.cwd);
  const limit = Math.max(1, input.limit ?? 100);
  const args = createGrepArguments(input, limit, searchPath);
  const { exitCode, limitReached, output, outputLimitReached } =
    await executeGrep(
      ["rg", ...args].map(shellQuote).join(" "),
      limit,
      execution
    );
  throwIfAborted(execution.signal);
  if (exitCode === 1 && output.length === 0) {
    return textResult("No matches found");
  }
  if (
    !(limitReached || outputLimitReached) &&
    exitCode !== 0 &&
    exitCode !== 1
  ) {
    throw new Error(output.trim() || `ripgrep exited with code ${exitCode}`);
  }

  const normalized = output
    .trimEnd()
    .split("\n")
    .map((line) => formatGrepPath(line, searchPath));
  const matchLimitReached = limitReached || normalized.length > limit;
  const truncation = truncateHead(normalized.slice(0, limit).join("\n"));
  const notices = [
    matchLimitReached ? `${limit} matches limit reached` : undefined,
    truncation.truncated ? "Output byte limit reached" : undefined,
  ].filter((notice): notice is string => notice !== undefined);
  const content = `${truncation.content}${
    notices.length > 0 ? `\n\n[${notices.join(". ")}]` : ""
  }`;
  return textResult(content || "No matches found", {
    ...(matchLimitReached ? { matchLimitReached: limit } : {}),
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
    if (
      input.multiline === true ||
      (input.outputMode ?? "content") !== "content"
    ) {
      return await grepWithNativeOptions(input, execution);
    }
    return await runDefinition(
      createGrepToolDefinition(execution.ctx.cwd),
      input,
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
