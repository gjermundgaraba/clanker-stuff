import { createLazySingleton } from "@clanker-stuff/lazy-singleton";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import type { CodeModeHostClient } from "./host-client.js";
import { DEFAULT_CODE_MODE_OUTPUT_TOKENS, MAX_CODE_MODE_OUTPUT_TOKENS } from "./protocol.js";
import type {
  NestedTool,
  RuntimeContentItem,
  RuntimeResponse,
  RuntimeToolResult,
  RuntimeToolTrace,
  RuntimeValue,
} from "./types.js";
import { RuntimeToolTraceSchema } from "./types.js";

const DEFAULT_WAIT_MS = 10_000;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const strict = { additionalProperties: false } as const;
const JsonRecordSchema = Type.Record(Type.String(), Type.Unknown());
type JsonRecord = Static<typeof JsonRecordSchema>;

const EXEC_PARAMETERS = Type.Object({ code: Type.String() }, strict);
const WAIT_PARAMETERS = Type.Object(
  {
    cell_id: Type.String(),
    max_tokens: Type.Optional(
      Type.Integer({
        default: DEFAULT_CODE_MODE_OUTPUT_TOKENS,
        maximum: MAX_CODE_MODE_OUTPUT_TOKENS,
        minimum: 1,
      }),
    ),
    terminate: Type.Optional(Type.Boolean()),
    yield_time_ms: Type.Optional(Type.Integer({ default: DEFAULT_WAIT_MS, minimum: 0 })),
  },
  strict,
);

const EXEC_DESCRIPTION = `Run JavaScript code to orchestrate/compose tool calls
- Evaluates the provided JavaScript code in a fresh V8 isolate as an async module.
- All nested tools are available on the global \`tools\` object, for example \`await tools.exec_command(...)\`.
- Nested tool methods take either a string or an object as their input argument.
- Nested tools return either an object or a string, based on the description.
- Runs raw JavaScript -- no Node, no file system, no network access, no console.
- Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.
- You may optionally start the tool input with a first-line pragma like \`// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}\`.
- \`yield_time_ms\` asks \`exec\` to yield early if the script is still running. Defaults to 10000 ms.
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

export interface CodeModeToolDescriptor {
  readonly definition: ToolDefinition;
  readonly namespace?: string;
  readonly outputSchema?: unknown;
}

type CodeModeClientFactory = (signal: AbortSignal) => Promise<CodeModeHostClient>;

export interface CodeModeRuntimeOptions {
  createClient?: CodeModeClientFactory;
}

const createCodeModeHostClient: CodeModeClientFactory = async (signal) => {
  const [{ ensureCodeModeHostBinary }, { CodeModeHostClient }] = await Promise.all([
    import("./binary.js"),
    import("./host-client.js"),
  ]);
  const binary = await ensureCodeModeHostBinary(signal);
  return new CodeModeHostClient(binary);
};

export class CodeModeRuntime {
  private readonly client;
  private nestedToolDescriptors: readonly CodeModeToolDescriptor[] = [];

  constructor(options: CodeModeRuntimeOptions = {}) {
    this.client = createLazySingleton(options.createClient ?? createCodeModeHostClient);
  }

  createTools(): ToolDefinition[] {
    const currentByName = () =>
      new Map(this.nestedTools().map((tool) => [tool.definition.name, tool] as const));
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
              extensionContext: ctx,
              onUpdate,
              toolCallId: id,
            },
            signal,
            this.nestedTools(),
          );
          return toCodeModeToolResult(response);
        },
        label: "Exec",
        name: "exec",
        parameters: EXEC_PARAMETERS,
        renderCall(args, theme) {
          const source = args.code ?? "(invalid source)";
          return new Text(
            `${theme.fg("toolTitle", theme.bold("exec"))}\n${theme.fg("toolOutput", source)}`,
            0,
            0,
          );
        },
        renderResult(result, options, theme, context) {
          return renderCodeModeResult(result, options, theme, context, currentByName());
        },
      }),
      defineTool({
        description: WAIT_DESCRIPTION,
        execute: async (id, params, signal, onUpdate, ctx) => {
          const client = await this.getClient(signal);
          const executionContext = {
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
                  signal,
                );
          return toCodeModeToolResult(response, params.max_tokens);
        },
        label: "Wait",
        name: "wait",
        parameters: WAIT_PARAMETERS,
        renderCall(args, theme) {
          const action = args.terminate === true ? "terminate" : "wait";
          return new Text(
            theme.fg("toolTitle", theme.bold(`${action} ${args.cell_id ?? ""}`)),
            0,
            0,
          );
        },
        renderResult(result, options, theme, context) {
          return renderCodeModeResult(result, options, theme, context, currentByName());
        },
      }),
    ];
  }

  setNestedTools(descriptors: readonly CodeModeToolDescriptor[]): void {
    this.nestedToolDescriptors = [...descriptors];
  }

  prompt = (): string => {
    const lines = this.nestedTools()
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(
        (tool) =>
          `### \`${tool.name}\`\n${tool.definition.description}\n\nUsage: \`${tool.usage}\``,
      );
    return `Tools available in exec:\n\n${lines.join("\n\n")}`;
  };

  async shutdown(): Promise<void> {
    await this.client.stop(async (client) => {
      await client.shutdown();
    });
  }

  private async getClient(signal: AbortSignal | undefined): Promise<CodeModeHostClient> {
    signal?.throwIfAborted();
    const client = await abortable(this.client.load(), signal);
    if (client === undefined) {
      throw new Error("Code Mode runtime is stopped");
    }
    return client;
  }

  private nestedTools(): NestedTool[] {
    return this.nestedToolDescriptors.map(toNestedTool);
  }
}

const abortable = async <T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
  signal?.throwIfAborted();
  if (signal === undefined) {
    return await promise;
  }
  const aborted = Promise.withResolvers<T>();
  const onAbort = () => {
    aborted.reject(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

export const toNestedTool = (descriptor: CodeModeToolDescriptor): NestedTool => {
  const { definition, namespace, outputSchema } = descriptor;
  const freeformProperty = freeformInputProperty(definition);
  const nested: NestedTool = {
    definition,
    kind: freeformProperty === undefined ? "function" : "freeform",
    name: codeModeName(definition.name, namespace),
    async invoke(input, context, signal) {
      signal.throwIfAborted();
      const argumentsValue = freeformProperty === undefined ? input : { [freeformProperty]: input };
      const prepared: RuntimeValue = definition.prepareArguments
        ? definition.prepareArguments(argumentsValue)
        : argumentsValue;
      if (!isRecord(prepared)) {
        throw new TypeError(`Invalid arguments for ${definition.name}`);
      }
      const validated: RuntimeValue = validateToolArguments(definition, {
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
        context.extensionContext,
      );
      const normalized = normalizeResult(result);
      context.captureResult?.(normalized);
      return nestedResultValue(definition.name, normalized, outputSchema);
    },
    usage: usageFor(codeModeName(definition.name, namespace)),
  };
  if (namespace !== undefined) {
    nested.namespace = namespace;
  }
  if (outputSchema !== undefined) {
    nested.outputSchema = outputSchema;
  }
  return nested;
};

const freeformInputProperty = (definition: ToolDefinition): string | undefined => {
  if (
    definition.constrainedSampling === undefined ||
    definition.constrainedSampling === false ||
    definition.constrainedSampling.type !== "grammar"
  ) {
    return undefined;
  }
  const schema = definition.parameters;
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    throw new Error(`Grammar-constrained tool ${definition.name} must have one string parameter`);
  }
  const properties = Object.entries(schema.properties);
  if (
    properties.length !== 1 ||
    !isRecord(properties[0]?.[1]) ||
    properties[0][1].type !== "string"
  ) {
    throw new Error(`Grammar-constrained tool ${definition.name} must have one string parameter`);
  }
  return properties[0][0];
};

const codeModeName = (name: string, namespace?: string): string => {
  if (namespace === undefined || namespace === "functions") {
    return name;
  }
  return namespace.endsWith("_") || name.startsWith("_")
    ? `${namespace}${name}`
    : `${namespace}__${name}`;
};

const usageFor = (name: string) => {
  switch (name) {
    case "exec_command": {
      return "const result = await tools.exec_command({ cmd: string, workdir?: string, yield_time_ms?: number, max_output_tokens?: number }); result.output";
    }
    case "write_stdin": {
      return "const result = await tools.write_stdin({ session_id: number, chars?: string, yield_time_ms?: number, max_output_tokens?: number }); result.output";
    }
    case "apply_patch": {
      return "await tools.apply_patch(patch)";
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
  result: RuntimeToolResult,
  outputSchema: RuntimeValue,
): RuntimeValue => {
  const image = result.content.find((item) => item.type === "image");
  if (image?.type === "image") {
    assertSupportedImageMimeType(image.mimeType);
    return {
      detail: "high",
      image_url: `data:${image.mimeType};base64,${image.data}`,
    };
  }
  const output = result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (name === "view_image") {
    throw new Error(
      "view_image did not return a supported image. Use PNG, JPEG, GIF, or WebP; convert SVG to PNG first.",
    );
  }
  if (outputSchema !== undefined) {
    try {
      const parsed: unknown = JSON.parse(output);
      return parsed;
    } catch (error) {
      throw new Error(`Nested tool ${name} declared structured output but returned invalid JSON`, {
        cause: error,
      });
    }
  }
  if (name === "exec_command" || name === "write_stdin") {
    if (!isRecord(result.details)) {
      throw new Error(`Nested tool ${name} returned no Code Mode result`);
    }
    const { codeModeResult } = result.details;
    if (isRecord(codeModeResult)) {
      return structuredClone(codeModeResult);
    }
    throw new Error(`Nested tool ${name} returned no Code Mode result`);
  }
  return output || "(no output)";
};

const normalizeResult = (result: AgentToolResult<unknown>): RuntimeToolResult => ({
  content: result.content.filter(
    (
      item,
    ): item is { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } =>
      item.type === "text" || item.type === "image",
  ),
  details: result.details,
});

const toCodeModeToolResult = (response: RuntimeResponse, maxTokens?: number) => {
  const scriptError = response.kind === "result" ? response.errorText : undefined;
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
      Math.max(1, maxTokens ?? response.maxOutputTokens ?? DEFAULT_CODE_MODE_OUTPUT_TOKENS),
    ) * 4;
  return {
    content: [{ text: status, type: "text" as const }, ...truncateTextContent(output, maxChars)],
    details: {
      cellId: response.cellId,
      codeMode: true,
      status: response.kind,
      traces: response.traces,
      droppedTraceCount:
        response.droppedTraceCount !== undefined && response.droppedTraceCount > 0
          ? response.droppedTraceCount
          : undefined,
      scriptError: hasScriptError ? scriptError : undefined,
    },
  };
};

export const toPiContent = (
  item: RuntimeContentItem,
):
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | undefined => {
  if (item.type === "input_text" && item.text !== undefined) {
    return { text: item.text, type: "text" };
  }
  if (item.type === "input_image" && item.image_url !== undefined) {
    const match = /^data:(?<mimeType>[^;,]+);base64,(?<data>.+)$/su.exec(item.image_url);
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
      `Unsupported Code Mode image type "${mimeType}". Use PNG, JPEG, GIF, or WebP; convert SVG to PNG first.`,
    );
  }
};

const truncateTextContent = <
  T extends { type: "text"; text: string } | { type: "image"; data: string; mimeType: string },
>(
  content: T[],
  maxChars: number,
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
  tools: Map<string, NestedTool>,
) => {
  const details = isRecord(result.details) ? result.details : {};
  const traces = Array.isArray(details.traces) ? details.traces.filter(isRuntimeToolTrace) : [];
  const container = new Container();
  const { status } = details;
  let statusColor: "error" | "success" | "warning" = "success";
  let statusText = "✓ completed";
  if (details.scriptError !== undefined) {
    statusColor = "error";
    statusText = "✗ error";
  } else if (status === "running") {
    statusColor = "warning";
    statusText = "● running";
  } else if (status === "yielded") {
    statusColor = "warning";
    statusText = "◌ yielded";
  } else if (status === "terminated") {
    statusText = "■ terminated";
  }
  container.addChild(new Text(theme.fg(statusColor, statusText), 0, 0));
  for (const trace of traces) {
    const nested = tools.get(trace.name);
    const renderContext = {
      ...context,
      args: trace.input,
      toolCallId: trace.id,
    };
    try {
      if (nested?.definition.renderCall) {
        container.addChild(nested.definition.renderCall(trace.input, theme, renderContext));
      } else {
        container.addChild(
          new Text(
            theme.fg(
              trace.status === "error" ? "error" : "toolTitle",
              `${trace.status === "done" ? "✓" : trace.status === "error" ? "✗" : "…"} ${trace.name}`,
            ),
            0,
            0,
          ),
        );
      }
      if (trace.result !== undefined && nested?.definition.renderResult !== undefined) {
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
            renderContext,
          ),
        );
      } else if (trace.error !== undefined && trace.error.length > 0) {
        container.addChild(new Text(theme.fg("error", trace.error), 1, 0));
      } else if (options.expanded && trace.result !== undefined) {
        const text = trace.result.content
          .filter((item): item is { type: "text"; text: string } => item.type === "text")
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

const isRecord = (value: RuntimeValue): value is JsonRecord => Value.Check(JsonRecordSchema, value);

const isRuntimeToolTrace = (value: RuntimeValue): value is RuntimeToolTrace =>
  Value.Check(RuntimeToolTraceSchema, value);
