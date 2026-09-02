// Tool schemas and descriptions in this file were adapted for this package from OpenAI Codex (Apache-2.0); see ../NOTICE and ../UPSTREAM.
import { open, readFile, stat } from "node:fs/promises";

import { createLazySingleton } from "@clanker-stuff/lazy-singleton";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { resolvePath } from "./path.js";
import type { ProcessManager, ProcessResult } from "./process.js";

const strict = { additionalProperties: false } as const;
const DEFAULT_OUTPUT_TOKEN_LIMIT = 10_000;
const CODE_MODE_OUTPUT_TOKEN_LIMIT = (1024 * 1024) / 4;
const NumberSchema = Type.Number();

export const CODEX_MODEL_IDS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);

const APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?
hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF (change_move change? | change)
filename: /(.+)/
add_line: "+" /(.*)/ LF -> line
change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF
%import common.LF`;

export const APPLY_PATCH_CONSTRAINED_SAMPLING = {
  type: "grammar",
  variants: { openai_lark: APPLY_PATCH_GRAMMAR },
} as const;

export const isCodexToolsModel = (model: ExtensionContext["model"]) =>
  model?.provider === "openai-codex" &&
  model.api === "openai-codex-responses" &&
  CODEX_MODEL_IDS.has(model.id) &&
  model.compat !== undefined &&
  "supportsOpenAIGrammarTools" in model.compat &&
  model.compat.supportsOpenAIGrammarTools === true;

const textResult = <Details>(text: string, details: Details) => ({
  content: [{ text, type: "text" as const }],
  details,
});

const approximateTokens = (bytes: number): number => Math.ceil(bytes / 4);

const rustLineCount = (value: string): number => {
  if (value === "") {
    return 0;
  }
  const parts = value.split(/\n/u);
  if (parts.at(-1) === "") {
    parts.pop();
  }
  return parts.length;
};

const utf8Prefix = (value: string, byteBudget: number): string => {
  let end = 0;
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > byteBudget) {
      break;
    }
    bytes += size;
    end += character.length;
  }
  return value.slice(0, end);
};

const utf8Suffix = (value: string, byteBudget: number): string => {
  const target = Math.max(0, Buffer.byteLength(value) - byteBudget);
  let byteOffset = 0;
  let stringOffset = 0;
  for (const character of value) {
    if (byteOffset >= target) {
      return value.slice(stringOffset);
    }
    byteOffset += Buffer.byteLength(character);
    stringOffset += character.length;
  }
  return "";
};

export interface TruncatedCodexOutput {
  content: string;
  originalTokenCount: number;
  truncated: boolean;
}

export const truncateCodexOutput = (output: string, maxTokens: number): TruncatedCodexOutput => {
  const totalBytes = Buffer.byteLength(output);
  const byteBudget = maxTokens * 4;
  const originalTokenCount = approximateTokens(totalBytes);
  if (totalBytes <= byteBudget) {
    return { content: output, originalTokenCount, truncated: false };
  }
  const leftBudget = Math.floor(byteBudget / 2);
  const rightBudget = byteBudget - leftBudget;
  const prefix = utf8Prefix(output, leftBudget);
  const suffix = utf8Suffix(output, rightBudget);
  const removedTokens = approximateTokens(totalBytes - byteBudget);
  return {
    content: [
      `Warning: truncated output (original token count: ${originalTokenCount})`,
      `Total output lines: ${rustLineCount(output)}`,
      "",
      `${prefix}…${removedTokens} tokens truncated…${suffix}`,
    ].join("\n"),
    originalTokenCount,
    truncated: true,
  };
};

const readSlice = async (
  file: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Buffer> => {
  const bytes = Buffer.allocUnsafe(length);
  const { bytesRead } = await file.read(bytes, 0, length, position);
  return bytes.subarray(0, bytesRead);
};

const isUtf8ContinuationByte = (byte: number | undefined): boolean =>
  byte !== undefined && byte >= 0x80 && byte <= 0xbf;

const MAX_UTF8_CONTINUATION_BYTES = 3;

const truncateProcessResultOutput = async (
  result: ProcessResult,
  maxTokens: number,
): Promise<
  ReturnType<typeof truncateCodexOutput> & {
    totalBytes: number;
  }
> => {
  const source = result.truncation;
  if (source === undefined || result.fullOutputPath === undefined) {
    return {
      ...truncateCodexOutput(result.output, maxTokens),
      totalBytes: Buffer.byteLength(result.output),
    };
  }
  const info = await stat(result.fullOutputPath);
  const totalBytes = info.size;
  const decodedTotalBytes = source.totalBytes;
  const byteBudget = maxTokens * 4;
  if (decodedTotalBytes <= byteBudget) {
    const content = await readFile(result.fullOutputPath, "utf-8");
    return {
      ...truncateCodexOutput(content, maxTokens),
      totalBytes,
    };
  }

  const leftBudget = Math.floor(byteBudget / 2);
  const rightBudget = byteBudget - leftBudget;
  const file = await open(result.fullOutputPath, "r");
  try {
    const prefixBytes = await readSlice(file, 0, leftBudget + 4);
    const suffixStart = Math.max(0, totalBytes - rightBudget - 4);
    const suffixBytes = await readSlice(file, suffixStart, totalBytes - suffixStart);
    let suffixOffset = 0;
    if (suffixStart > 0) {
      while (
        suffixOffset < MAX_UTF8_CONTINUATION_BYTES &&
        suffixOffset < suffixBytes.length &&
        isUtf8ContinuationByte(suffixBytes[suffixOffset])
      ) {
        suffixOffset += 1;
      }
    }
    const prefix = utf8Prefix(prefixBytes.toString("utf-8"), leftBudget);
    const suffix = utf8Suffix(suffixBytes.subarray(suffixOffset).toString("utf-8"), rightBudget);
    return {
      content: [
        `Warning: truncated output (original token count: ${approximateTokens(decodedTotalBytes)})`,
        `Total output lines: ${source.totalLines}`,
        "",
        `${prefix}…${approximateTokens(decodedTotalBytes - byteBudget)} tokens truncated…${suffix}`,
      ].join("\n"),
      originalTokenCount: approximateTokens(decodedTotalBytes),
      totalBytes,
      truncated: true,
    };
  } finally {
    await file.close();
  }
};

const outputTokenPolicy = (ctx: Pick<ExtensionContext, "model" | "modelRegistry">): number => {
  const selected = ctx.model;
  const current =
    selected === undefined ? undefined : ctx.modelRegistry.find(selected.provider, selected.id);
  const model = current ?? selected;
  const configured =
    model !== undefined && "codexOutputTokenLimit" in model
      ? model.codexOutputTokenLimit
      : undefined;
  return Value.Check(NumberSchema, configured) &&
    Number.isSafeInteger(configured) &&
    configured >= 0
    ? configured
    : DEFAULT_OUTPUT_TOKEN_LIMIT;
};

const formatProcessMetadata = (result: ProcessResult): string => {
  let status = `Process exited with code ${result.exitCode ?? "unknown"}.`;
  if (result.status === "running") {
    status = "Process is still running.";
  } else if (result.status === "killed") {
    status = "Process was killed.";
  }
  const output = [status];
  if (result.fullOutputPath !== undefined && result.fullOutputPath.length > 0) {
    output.push(`[Full output: ${result.fullOutputPath}]`);
  }
  if (result.sessionId !== undefined) {
    output.push(`Session ID: ${result.sessionId}`);
  }
  return output.join("\n\n");
};

const codeModeResult = (
  result: ProcessResult,
  output: ReturnType<typeof truncateCodexOutput> | undefined,
) => {
  const formatted = {
    exit_code: result.exitCode,
    output: output?.content ?? result.output,
    wall_time_seconds: result.durationMs / 1000,
  };
  if (output !== undefined) {
    Object.assign(formatted, { original_token_count: output.originalTokenCount });
  }
  if (result.sessionId !== undefined) {
    Object.assign(formatted, { session_id: result.sessionId });
  }
  return formatted;
};

const processResult = async (
  result: ProcessResult,
  maxOutputTokens: number | undefined,
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  nested: boolean,
): Promise<AgentToolResult<unknown>> => {
  const effectiveLimit = Math.min(
    maxOutputTokens ?? DEFAULT_OUTPUT_TOKEN_LIMIT,
    outputTokenPolicy(ctx),
  );
  const truncated = await truncateProcessResultOutput(result, effectiveLimit);
  let nestedOutput: ReturnType<typeof truncateCodexOutput> | undefined;
  if (nested) {
    if (maxOutputTokens === undefined) {
      nestedOutput = await truncateProcessResultOutput(result, CODE_MODE_OUTPUT_TOKEN_LIMIT);
    } else {
      const nestedLimit = Math.min(maxOutputTokens, CODE_MODE_OUTPUT_TOKEN_LIMIT);
      nestedOutput =
        nestedLimit === effectiveLimit
          ? truncated
          : await truncateProcessResultOutput(result, nestedLimit);
    }
  }
  const metadata = formatProcessMetadata(result);
  const content = truncated.content.length === 0 ? metadata : `${truncated.content}\n\n${metadata}`;
  const { output: _output, ...details } = result;
  const resultDetails = {
    ...details,
    effectiveMaxOutputTokens: effectiveLimit,
  };
  if (nested) {
    Object.assign(resultDetails, { codeModeResult: codeModeResult(result, nestedOutput) });
  }
  if (maxOutputTokens !== undefined) {
    Object.assign(resultDetails, { requestedMaxOutputTokens: maxOutputTokens });
  }
  if (truncated.truncated) {
    Object.assign(resultDetails, {
      requestedBudgetTruncation: {
        originalTokenCount: truncated.originalTokenCount,
        totalBytes: truncated.totalBytes,
        truncatedBy: "tokens",
      },
    });
  }
  return textResult(content, resultDetails);
};

export const createCodexDirectTools = () => {
  const processes = createLazySingleton<ProcessManager>(async (signal) => {
    const { ProcessManager } = await import("./process.js");
    signal.throwIfAborted();
    return new ProcessManager();
  });
  const processManager = async (): Promise<ProcessManager> => {
    const manager = await processes.load();
    if (manager === undefined) {
      throw new Error("Process manager is disposed");
    }
    return manager;
  };
  const execCommand = (nested: boolean) =>
    defineTool({
      name: "exec_command",
      label: "Execute Command",
      description:
        "Runs a shell command. Long-running commands return a session ID for write_stdin.",
      parameters: Type.Object(
        {
          cmd: Type.String(),
          max_output_tokens: Type.Optional(
            Type.Integer({
              description:
                "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
              minimum: 0,
            }),
          ),
          workdir: Type.Optional(Type.String()),
          yield_time_ms: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        strict,
      ),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const manager = await processManager();
        return await processResult(
          await manager.start({
            command: params.cmd,
            ctx,
            cwd: params.workdir === undefined ? ctx.cwd : resolvePath(params.workdir, ctx.cwd),
            signal,
            yieldMs: params.yield_time_ms ?? 10_000,
          }),
          params.max_output_tokens,
          ctx,
          nested,
        );
      },
    });
  const writeStdin = (nested: boolean) =>
    defineTool({
      name: "write_stdin",
      label: "Write Stdin",
      description: "Writes to or polls a running exec_command session.",
      parameters: Type.Object(
        {
          session_id: Type.Integer({ minimum: 1 }),
          chars: Type.Optional(Type.String()),
          max_output_tokens: Type.Optional(
            Type.Integer({
              description:
                "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
              minimum: 0,
            }),
          ),
          yield_time_ms: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        strict,
      ),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const manager = await processManager();
        return await processResult(
          await manager.continue({
            chars: params.chars,
            sessionId: params.session_id,
            signal,
            yieldMs:
              params.yield_time_ms ??
              (params.chars === undefined || params.chars.length === 0 ? 5000 : 250),
          }),
          params.max_output_tokens,
          ctx,
          nested,
        );
      },
    });
  const sharedDefinitions = [
    defineTool({
      name: "apply_patch",
      label: "Apply Patch",
      description:
        "Apply a patch to files. Provide the patch directly, from *** Begin Patch through *** End Patch; do not wrap it in JSON.",
      parameters: Type.Object(
        { patch: Type.String({ description: "The complete patch text" }) },
        strict,
      ),
      constrainedSampling: APPLY_PATCH_CONSTRAINED_SAMPLING,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const { applyPatch } = await import("./patch.js");
        const result = await applyPatch(params.patch, ctx.cwd, signal);
        return textResult(result.output, {
          changes: result.changes,
        });
      },
    }),
    defineTool({
      name: "view_image",
      label: "View Image",
      description: "Attach a local image to the conversation.",
      parameters: Type.Object({ path: Type.String() }, strict),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return await createReadToolDefinition(ctx.cwd).execute(
          toolCallId,
          { path: params.path },
          signal,
          onUpdate,
          ctx,
        );
      },
    }),
  ];
  const definitions = [execCommand(false), writeStdin(false), ...sharedDefinitions];
  return {
    definitions,
    dispose: () => processes.stop((manager) => manager.dispose()),
    nestedDefinitions: [execCommand(true), writeStdin(true), ...sharedDefinitions],
  };
};
