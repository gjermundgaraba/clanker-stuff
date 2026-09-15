// Tool descriptions in this file were adapted for this package from OpenAI Codex (Apache-2.0); see ./NOTICE and ./UPSTREAM.
import { createLazySingleton } from "@clanker-stuff/lazy-singleton";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { operationSignal, raceWithAbortSignal } from "#pi-abort";
import { resolveGrammarConstrainedSampling } from "#pi-constrained-sampling";

import type { CodeModeHostClient } from "./host-client.js";
import { DEFAULT_CODE_MODE_OUTPUT_TOKENS, MAX_CODE_MODE_OUTPUT_TOKENS } from "./protocol.js";
import { codeModeRenderers } from "./renderers.js";
import type {
  NestedTool,
  RuntimeContentItem,
  RuntimeResponse,
  RuntimeToolResult,
} from "./types.js";

const DEFAULT_WAIT_MS = 10_000;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
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

export const EXEC_CONSTRAINED_SAMPLING = {
  type: "grammar",
  variants: { openai_lark: EXEC_GRAMMAR },
} as const;

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
        constrainedSampling: EXEC_CONSTRAINED_SAMPLING,
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
        ...codeModeRenderers("exec", currentByName),
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
        ...codeModeRenderers("wait", currentByName),
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
    const client = await raceWithAbortSignal(this.client.load(), operationSignal(signal));
    if (client === undefined) {
      throw new Error("Code Mode runtime is stopped");
    }
    return client;
  }

  private nestedTools(): NestedTool[] {
    return this.nestedToolDescriptors.map(toNestedTool);
  }
}

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
      const prepared: unknown = definition.prepareArguments
        ? definition.prepareArguments(argumentsValue)
        : argumentsValue;
      if (!isRecord(prepared)) {
        throw new TypeError(`Invalid arguments for ${definition.name}`);
      }
      const validated: unknown = validateToolArguments(definition, {
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
      context.captureResult?.(result);
      return nestedResultValue(definition.name, result, outputSchema);
    },
    usage: usageFor(codeModeName(definition.name, namespace)),
  };
  if (freeformProperty !== undefined) {
    nested.freeformProperty = freeformProperty;
  }
  if (namespace !== undefined) {
    nested.namespace = namespace;
  }
  if (outputSchema !== undefined) {
    nested.outputSchema = outputSchema;
  }
  return nested;
};

const freeformInputProperty = (definition: ToolDefinition): string | undefined => {
  const grammar = resolveGrammarConstrainedSampling(definition, true);
  if (grammar === undefined) {
    return undefined;
  }
  // Code Mode passes only the freeform string, never additional optional arguments.
  const schema = definition.parameters;
  if (
    !isRecord(schema) ||
    !isRecord(schema.properties) ||
    Object.keys(schema.properties).length !== 1
  ) {
    throw new Error(`Grammar-constrained tool ${definition.name} must have one string parameter`);
  }
  return grammar.inputProperty;
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

const nestedResultValue = (name: string, result: RuntimeToolResult, outputSchema: unknown) => {
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
      elapsedMs: response.elapsedMs,
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
