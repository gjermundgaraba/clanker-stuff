/* oxlint-disable eslint/no-use-before-define, eslint/no-nested-ternary, unicorn/no-nested-ternary, eslint/class-methods-use-this, eslint/complexity -- tool definitions read top-down while rendering handles each trace state */
import { validateToolArguments } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { ensureCodeModeHostBinary } from "./binary.js";
import { CodeModeHostClient } from "./host-client.js";
import {
  DEFAULT_CODE_MODE_OUTPUT_TOKENS,
  MAX_CODE_MODE_OUTPUT_TOKENS,
} from "./protocol.js";
import type {
  NestedTool,
  RuntimeContentItem,
  RuntimeResponse,
  RuntimeToolResult,
  RuntimeToolTrace,
} from "./types.js";

const DEFAULT_WAIT_MS = 10_000;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const strict = { additionalProperties: false } as const;

const EXEC_PARAMETERS = Type.Object({ code: Type.String() }, strict);
const WAIT_PARAMETERS = Type.Object(
  {
    cell_id: Type.String(),
    max_tokens: Type.Optional(
      Type.Integer({
        default: DEFAULT_CODE_MODE_OUTPUT_TOKENS,
        maximum: MAX_CODE_MODE_OUTPUT_TOKENS,
        minimum: 1,
      })
    ),
    terminate: Type.Optional(Type.Boolean()),
    yield_time_ms: Type.Optional(
      Type.Integer({ default: DEFAULT_WAIT_MS, minimum: 0 })
    ),
  },
  strict
);

const EXEC_DESCRIPTION = `Run JavaScript code to orchestrate/compose tool calls
- Evaluates the provided JavaScript code in a fresh V8 isolate as an async module.
- All nested tools are available on the global \`tools\` object, for example \`await tools.exec_command(...)\`.
- Nested tool methods take either a string or an object as their input argument.
- Nested tools return either an object or a string, based on the description.
- Runs raw JavaScript -- no Node, no file system, no network access, no console.
- Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.
- You may optionally start the tool input with a first-line pragma like \`// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}\`.
- \`yield_time_ms\` asks \`exec\` to yield early if the script is still running. Defaults to 30000 ms.
- \`max_output_tokens\` sets the token budget for direct \`exec\` results. Defaults to 10000 tokens.
- When the JS code is fully evaluated, the isolate's lifetime ends and unawaited promises are silently discarded.

- Global helpers:
- \`exit()\`: Immediately ends the current script successfully (like an early return from the top level).
- \`text(value: string | number | boolean | undefined | null)\`: Appends a text item. Non-string values are stringified with \`JSON.stringify(...)\` when possible.
- \`image(imageUrlOrItem, detail?)\`: Appends an image item. \`image_url\` should be a base64-encoded \`data:\` URL.
- \`generatedImage(result: { image_url: string; output_hint?: string })\`: Appends an image-generation result and its optional output hint. HTTP(S) URLs are not supported.
- \`store(key: string, value: any)\`: Stores a serializable value under a string key for later \`exec\` calls in the same session.
- \`load(key: string)\`: Returns the stored value for a string key, or \`undefined\` if it is missing.
- \`notify(value: string | number | boolean | undefined | null)\`: Immediately emits output for the current \`exec\` call. Values are stringified like \`text(...)\`.
- \`setTimeout(callback: () => void, delayMs?: number)\`: Schedules a callback and returns a timeout id. Pending timeouts do not keep \`exec\` alive; await an explicit promise if needed.
- \`clearTimeout(timeoutId?: number)\`: Cancels a timeout created by \`setTimeout\`.
- \`ALL_TOOLS\`: Metadata for the enabled nested tools as \`{ name, description }\` entries.
- \`yield_control()\`: Yields accumulated output immediately while the script keeps running.`;

const WAIT_DESCRIPTION = `- Use \`wait\` only after \`exec\` returns a running cell ID.
- \`cell_id\` identifies the running \`exec\` cell to resume.
- \`yield_time_ms\` controls how long to wait for more output before yielding again. Defaults to 10000 ms.
- \`max_tokens\` limits how much new output this wait call returns. Defaults to 10000 tokens.
- \`terminate: true\` stops the running cell; false or omitted waits for output.
- \`wait\` returns only new output since the last yield, or the final completion or termination result.
- If the cell is still running, \`wait\` may yield again with the same \`cell_id\`.
- If the cell has already finished, \`wait\` returns the completed result and closes the cell.`;

const EXEC_GRAMMAR = String.raw`
start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`;

export class CodeModeRuntime {
  private client: CodeModeHostClient | undefined;
  private clientPromise: Promise<CodeModeHostClient> | undefined;

  createTools(definitions: ToolDefinition[]): ToolDefinition[] {
    const nested = definitions.map(toNestedTool);
    const byName = new Map(nested.map((tool) => [tool.definition.name, tool]));
    return [
      defineTool({
        constrainedSampling: {
          type: "grammar",
          variants: { openai_lark: EXEC_GRAMMAR },
        },
        description: EXEC_DESCRIPTION,
        execute: async (id, params, signal, onUpdate, ctx) => {
          const client = await this.getClient(signal);
          const response = await client.execute(
            params.code,
            {
              cwd: ctx.cwd,
              extensionContext: ctx,
              onUpdate,
              toolCallId: id,
            },
            signal,
            nested
          );
          return toCodeModeToolResult(response);
        },
        label: "Exec",
        name: "exec",
        parameters: EXEC_PARAMETERS,
        renderCall(args, theme) {
          const source =
            typeof args.code === "string" ? args.code : "(invalid source)";
          return new Text(
            `${theme.fg("toolTitle", theme.bold("exec"))}\n${theme.fg(
              "toolOutput",
              source
            )}`,
            0,
            0
          );
        },
        renderResult(result, options, theme, context) {
          return renderCodeModeResult(result, options, theme, context, byName);
        },
      }),
      defineTool({
        description: WAIT_DESCRIPTION,
        execute: async (id, params, signal, onUpdate, ctx) => {
          const client = await this.getClient(signal);
          const executionContext = {
            cwd: ctx.cwd,
            extensionContext: ctx,
            onUpdate,
            toolCallId: id,
          };
          const response =
            params.terminate === true
              ? await client.terminate(params.cell_id, executionContext, signal)
              : await client.wait(
                  params.cell_id,
                  params.yield_time_ms ?? DEFAULT_WAIT_MS,
                  executionContext,
                  signal
                );
          return toCodeModeToolResult(response, params.max_tokens);
        },
        label: "Wait",
        name: "wait",
        parameters: WAIT_PARAMETERS,
        renderCall(args, theme) {
          const action = args.terminate === true ? "terminate" : "wait";
          return new Text(
            theme.fg(
              "toolTitle",
              theme.bold(`${action} ${args.cell_id ?? ""}`)
            ),
            0,
            0
          );
        },
        renderResult(result, options, theme, context) {
          return renderCodeModeResult(result, options, theme, context, byName);
        },
      }),
    ];
  }

  prompt = (definitions: ToolDefinition[]): string => {
    const lines = definitions
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(
        (definition) =>
          `### \`${definition.name}\`\n${definition.description}\n\nUsage: \`${usageFor(definition.name)}\``
      );
    return `Tools available in exec:\n\n${lines.join("\n\n")}`;
  };

  async shutdown(): Promise<void> {
    const { client } = this;
    this.client = undefined;
    this.clientPromise = undefined;
    await client?.shutdown();
  }

  private async getClient(
    signal: AbortSignal | undefined
  ): Promise<CodeModeHostClient> {
    if (this.client) {
      return this.client;
    }
    this.clientPromise ??= this.createClient(signal);
    try {
      this.client = await this.clientPromise;
      return this.client;
    } catch (error) {
      this.clientPromise = undefined;
      throw error;
    }
  }

  private async createClient(signal: AbortSignal | undefined) {
    const binary = await ensureCodeModeHostBinary(signal);
    return new CodeModeHostClient(binary);
  }
}

export const toNestedTool = (definition: ToolDefinition): NestedTool => ({
  definition,
  async invoke(input, context, signal) {
    signal.throwIfAborted();
    const prepared: unknown = definition.prepareArguments
      ? definition.prepareArguments(input)
      : input;
    if (!isRecord(prepared)) {
      throw new TypeError(`Invalid arguments for ${definition.name}`);
    }
    const validated = validateToolArguments(definition, {
      arguments: prepared,
      id: context.toolCallId ?? `code-mode-${definition.name}`,
      name: definition.name,
      type: "toolCall",
    });
    signal.throwIfAborted();
    const result = await definition.execute(
      context.toolCallId ?? `code-mode-${definition.name}`,
      validated,
      signal,
      (update) => {
        context.onUpdate?.(update);
      },
      context.extensionContext
    );
    const normalized = normalizeResult(result);
    context.captureResult?.(normalized);
    return nestedResultValue(definition.name, normalized);
  },
  usage: usageFor(definition.name),
});

const usageFor = (name: string) => {
  switch (name) {
    case "exec_command": {
      return "await tools.exec_command({ cmd: string, workdir?: string, yield_time_ms?: number })";
    }
    case "write_stdin": {
      return "await tools.write_stdin({ session_id: number, chars?: string, yield_time_ms?: number })";
    }
    case "apply_patch": {
      return "await tools.apply_patch({ patch: string })";
    }
    case "view_image": {
      return "const result = await tools.view_image({ path: string }); image(result)";
    }
    default: {
      return `await tools.${name}(input)`;
    }
  }
};

const nestedResultValue = (
  name: string,
  result: RuntimeToolResult
): unknown => {
  const image = result.content.find((item) => item.type === "image");
  if (image?.type === "image") {
    assertSupportedImageMimeType(image.mimeType);
    return {
      detail: "high",
      image_url: `data:${image.mimeType};base64,${image.data}`,
    };
  }
  const output = result.content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text"
    )
    .map((item) => item.text)
    .join("\n");
  if (name === "view_image") {
    throw new Error(
      "view_image did not return a supported image. Use PNG, JPEG, GIF, or WebP; convert SVG to PNG first."
    );
  }
  if (
    (name === "exec_command" || name === "write_stdin") &&
    isRecord(result.details)
  ) {
    const { details } = result;
    return {
      duration_ms: details.durationMs,
      exit_code: details.exitCode,
      full_output_path: details.fullOutputPath,
      output,
      running: details.running,
      session_id: details.sessionId,
      status: details.status,
      truncation: details.truncation,
    };
  }
  if (isRecord(result.details) && "output" in result.details) {
    return result.details;
  }
  return output || "(no output)";
};

const normalizeResult = (
  result: AgentToolResult<unknown>
): RuntimeToolResult => ({
  content: result.content.filter(
    (
      item
    ): item is
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string } =>
      item.type === "text" || item.type === "image"
  ),
  details: result.details,
});

const toCodeModeToolResult = (
  response: RuntimeResponse,
  maxTokens?: number
) => {
  const scriptError =
    response.kind === "result" ? response.errorText : undefined;
  const hasScriptError = scriptError !== undefined && scriptError.length > 0;
  const status = hasScriptError
    ? `Script error: ${scriptError}`
    : response.kind === "yielded"
      ? `Still running. Call wait({ cell_id: "${response.cellId}" })`
      : response.kind === "terminated"
        ? "Script terminated"
        : "Script completed";
  const output = response.contentItems
    .map(toPiContent)
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const maxChars =
    Math.min(
      MAX_CODE_MODE_OUTPUT_TOKENS,
      Math.max(
        1,
        maxTokens ?? response.maxOutputTokens ?? DEFAULT_CODE_MODE_OUTPUT_TOKENS
      )
    ) * 4;
  return {
    content: [
      { text: status, type: "text" as const },
      ...truncateTextContent(output, maxChars),
    ],
    details: {
      cellId: response.cellId,
      codeMode: true,
      status: response.kind,
      ...(response.traces ? { traces: response.traces } : {}),
      ...(response.droppedTraceCount !== undefined &&
      response.droppedTraceCount > 0
        ? { droppedTraceCount: response.droppedTraceCount }
        : {}),
      ...(hasScriptError ? { scriptError } : {}),
    },
  };
};

export const toPiContent = (
  item: RuntimeContentItem
):
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | undefined => {
  if (item.type === "input_text" && typeof item.text === "string") {
    return { text: item.text, type: "text" };
  }
  if (item.type === "input_image" && typeof item.image_url === "string") {
    const match = /^data:(?<mimeType>[^;,]+);base64,(?<data>.+)$/su.exec(
      item.image_url
    );
    if (
      match?.groups?.mimeType !== undefined &&
      match.groups.mimeType.length > 0 &&
      match.groups.data !== undefined &&
      match.groups.data.length > 0
    ) {
      const mimeType = match.groups.mimeType.toLowerCase();
      assertSupportedImageMimeType(mimeType);
      return {
        data: match.groups.data,
        mimeType,
        type: "image",
      };
    }
  }
  return undefined;
};

const assertSupportedImageMimeType = (mimeType: string): void => {
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType.toLowerCase())) {
    throw new Error(
      `Unsupported Code Mode image type "${mimeType}". Use PNG, JPEG, GIF, or WebP; convert SVG to PNG first.`
    );
  }
};

const truncateTextContent = <
  T extends
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string },
>(
  content: T[],
  maxChars: number
): T[] => {
  let remaining = maxChars;
  return content.flatMap((item) => {
    if (item.type !== "text") {
      return [item];
    }
    if (remaining <= 0) {
      return [];
    }
    if (item.text.length <= remaining) {
      remaining -= item.text.length;
      return [item];
    }
    const truncated = {
      ...item,
      text: `${item.text.slice(0, remaining)}\n[Output truncated]`,
    };
    remaining = 0;
    return [truncated];
  });
};

const renderCodeModeResult = (
  result: AgentToolResult<unknown>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2],
  context: Parameters<NonNullable<ToolDefinition["renderResult"]>>[3],
  tools: Map<string, NestedTool>
) => {
  const details = isRecord(result.details) ? result.details : {};
  const traces = Array.isArray(details.traces)
    ? details.traces.filter(isRuntimeToolTrace)
    : [];
  const container = new Container();
  const status =
    typeof details.status === "string" ? details.status : "completed";
  container.addChild(
    new Text(
      theme.fg(
        status === "running" || status === "yielded" ? "warning" : "success",
        status
      ),
      0,
      0
    )
  );
  for (const trace of traces) {
    const nested = tools.get(trace.name);
    const renderContext = {
      ...context,
      args: trace.input,
      toolCallId: trace.id,
    };
    try {
      if (nested?.definition.renderCall) {
        container.addChild(
          nested.definition.renderCall(trace.input, theme, renderContext)
        );
      } else {
        container.addChild(
          new Text(
            theme.fg(
              trace.status === "error" ? "error" : "toolTitle",
              `${trace.status === "done" ? "✓" : trace.status === "error" ? "✗" : "…"} ${trace.name}`
            ),
            0,
            0
          )
        );
      }
      if (
        trace.result !== undefined &&
        nested?.definition.renderResult !== undefined
      ) {
        container.addChild(
          nested.definition.renderResult(
            {
              content: trace.result.content,
              details: trace.result.details,
            },
            {
              expanded: options.expanded,
              isPartial: trace.status === "running",
            },
            theme,
            renderContext
          )
        );
      } else if (trace.error !== undefined && trace.error.length > 0) {
        container.addChild(new Text(theme.fg("error", trace.error), 1, 0));
      } else if (options.expanded && trace.result !== undefined) {
        const text = trace.result.content
          .filter(
            (item): item is { type: "text"; text: string } =>
              item.type === "text"
          )
          .map((item) => item.text)
          .join("\n");
        if (text.length > 0) {
          container.addChild(new Text(theme.fg("toolOutput", text), 1, 0));
        }
      }
    } catch {
      container.addChild(new Text(trace.name, 0, 0));
    }
  }
  return container;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRuntimeToolTrace = (value: unknown): value is RuntimeToolTrace =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  (value.status === "running" ||
    value.status === "done" ||
    value.status === "error") &&
  (value.error === undefined || typeof value.error === "string") &&
  (value.result === undefined || isRuntimeToolResult(value.result));

const isRuntimeToolResult = (value: unknown): value is RuntimeToolResult =>
  isRecord(value) &&
  Array.isArray(value.content) &&
  value.content.every(
    (item: unknown) =>
      isRecord(item) &&
      ((item.type === "text" && typeof item.text === "string") ||
        (item.type === "image" &&
          typeof item.data === "string" &&
          typeof item.mimeType === "string"))
  );
