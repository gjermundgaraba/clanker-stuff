// Tool descriptions were adapted from OpenAI Codex (Apache-2.0); see ../NOTICE and ../UPSTREAM.
import { createLazySingleton } from "@clanker-stuff/lazy-singleton";
import { structuralSchema } from "@clanker-stuff/pi-tool-schema";
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import type { ToolDefinition, ToolLoadout } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { operationSignal, raceWithAbortSignal } from "#pi-abort";
import { resolveGrammarConstrainedSampling } from "#pi-constrained-sampling";

import type { CodeModeHostClient } from "./host-client.js";
import {
  DEFAULT_CODE_MODE_OUTPUT_TOKENS,
  JsonObjectSchema,
  MAX_CODE_MODE_OUTPUT_TOKENS,
} from "./protocol.js";
import { codeModeRenderers } from "./renderers.js";
import type {
  NestedTool,
  RuntimeContentItem,
  RuntimeResponse,
  RuntimeToolResult,
  ToolMetadata,
} from "./types.js";

const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

const EXEC_PARAMETERS = structuralSchema(
  Type.Object({ code: Type.String() }, { additionalProperties: false }),
);

const EXEC_DESCRIPTION = `Run JavaScript code to orchestrate/compose tool calls
- Evaluates raw JavaScript in a fresh V8 isolate as an async module, with top-level await.
- Calls tools through the global tools object, for example await tools.exec_command({ cmd: "pwd" }).
- Nested calls use Pi's validation, permission hooks, cancellation, and execution policy.
- Function tools take an argument object; freeform tools take a string.
- Tools with an output schema return structured data; other tools return text or an image.
- No Node, file system, network access, or console is available in the isolate.
- The exec call stays active until the script completes, fails, or is cancelled. There is no wait tool.
- Long-running work should use exec_command process sessions or background task tools.
- An optional first-line pragma // @exec: {"max_output_tokens": 1000} sets the output budget (default 10000).
- text(value) appends output; image(dataUrlOrImage) displays an image; generatedImage(result) displays result.image_url.
- exit() ends the script successfully. Earlier tool side effects are not undone on failure.
- store(key, value) and load(key) retain JSON values between scripts in this host session.
- notify(value) emits live output. yield_control() publishes accumulated output without ending exec.
- setTimeout(callback, delayMs) and clearTimeout(id) are available. Await timers you need to keep alive.
- ALL_TOOLS lists enabled nested tools as { name, description }.
- When the script ends, unawaited work is cancelled and settled before exec returns.`;

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

type CodeModeClientFactory = (signal: AbortSignal) => Promise<CodeModeHostClient>;

export interface CodeModeRuntimeOptions {
  createClient?: CodeModeClientFactory;
  renderers?: readonly ToolMetadata[];
}

const createCodeModeHostClient: CodeModeClientFactory = async (signal) => {
  const [{ ensureCodeModeHostBinary }, { CodeModeHostClient }] = await Promise.all([
    import("./binary.js"),
    import("./host-client.js"),
  ]);

  return new CodeModeHostClient(await ensureCodeModeHostBinary(signal));
};

export class CodeModeRuntime {
  private readonly client;
  private tools: NestedTool[] = [];
  private readonly renderers: ReadonlyMap<string, ToolMetadata>;

  constructor(options: CodeModeRuntimeOptions = {}) {
    this.client = createLazySingleton(options.createClient ?? createCodeModeHostClient);
    this.renderers = new Map((options.renderers ?? []).map((tool) => [tool.name, tool]));
  }

  createTools(): ToolDefinition[] {
    return [this.createExecTool()];
  }

  createExecTool(nestedOnly: () => boolean = () => true): ToolDefinition {
    return defineTool({
      name: "exec",
      label: "Exec",
      exposure: "model-only",
      defaultActive: false,
      constrainedSampling: EXEC_CONSTRAINED_SAMPLING,
      parameters: EXEC_PARAMETERS,
      description: EXEC_DESCRIPTION,
      prepareLoadout: (loadout) => {
        this.tools = this.loadoutTools(loadout);

        const sections = this.tools
          .toSorted((left, right) => left.name.localeCompare(right.name))
          .map(
            (tool) =>
              `### \`${tool.name}\`\n${tool.definition.description}\n${(tool.definition.promptGuidelines ?? []).join("\n")}\nParameters: ${JSON.stringify(tool.definition.parameters)}\nUsage: \`${tool.usage}\``,
          );

        return {
          descriptions: {
            exec: `${EXEC_DESCRIPTION}\n\nTools available in exec:\n\n${sections.join("\n\n")}`,
          },
          hiddenDeclarations: nestedOnly()
            ? loadout.declared
                .filter((tool) => loadout.callable.some((callable) => callable.name === tool.name))
                .map((tool) => tool.name)
            : [],
        };
      },
      execute: async (_id, params, signal, onUpdate, ctx) => {
        signal?.throwIfAborted();
        const client = await raceWithAbortSignal(this.client.load(), operationSignal(signal));
        signal?.throwIfAborted();

        if (!client) throw new Error("Code Mode runtime is stopped");

        // Resolve the inventory at execution entry, not from a retained executable snapshot.
        const tools = checkedToolNames(
          ctx.tools.map((tool) =>
            toNestedTool(
              tool,
              this.tools.find((nested) => nested.definition.name === tool.name)?.namespace,
            ),
          ),
        );

        return toCodeModeToolResult(
          await client.execute(
            params.code,
            {
              extensionContext: ctx,
              ...(onUpdate !== undefined ? { onUpdate } : {}),
            },
            signal,
            tools,
          ),
        );
      },
      ...codeModeRenderers(
        "exec",
        () => new Map(this.tools.map((tool) => [tool.definition.name, tool])),
      ),
    });
  }

  private loadoutTools(loadout: ToolLoadout): NestedTool[] {
    return checkedToolNames(
      loadout.callable.map((tool) => {
        const renderer = this.renderers.get(tool.name);

        const nested = toNestedTool(
          {
            ...tool,
            ...(renderer?.renderCall ? { renderCall: renderer.renderCall } : {}),
            ...(renderer?.renderResult ? { renderResult: renderer.renderResult } : {}),
          },
          loadout.getNamespace(tool.name)?.name,
        );

        return nested;
      }),
    );
  }

  async shutdown(): Promise<void> {
    await this.client.stop((client) => client.shutdown());
  }
}

const checkedToolNames = (tools: NestedTool[]): NestedTool[] => {
  const names = new Set(["exec"]);

  for (const tool of tools) {
    if (names.has(tool.name))
      throw new Error(`Duplicate or reserved Code Mode tool name: ${tool.name}`);
    names.add(tool.name);
  }

  return tools;
};

export const toNestedTool = (tool: ToolMetadata, namespace?: string): NestedTool => {
  // Metadata only: never retain the registered executor in a script's wire inventory.
  const definition: ToolMetadata = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.constrainedSampling !== undefined
      ? { constrainedSampling: tool.constrainedSampling }
      : {}),
    ...(tool.promptGuidelines !== undefined ? { promptGuidelines: tool.promptGuidelines } : {}),
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.renderCall !== undefined ? { renderCall: tool.renderCall } : {}),
    ...(tool.renderResult !== undefined ? { renderResult: tool.renderResult } : {}),
  };

  const freeformProperty = freeformInputProperty(definition);
  const name = codeModeName(definition.name, namespace);

  return {
    definition,
    kind: freeformProperty === undefined ? "function" : "freeform",
    name,
    ...(freeformProperty !== undefined ? { freeformProperty } : {}),
    ...(namespace !== undefined ? { namespace } : {}),
    ...(definition.outputSchema !== undefined ? { outputSchema: definition.outputSchema } : {}),
    usage: `await tools.${name}(${freeformProperty === undefined ? "input" : "source"})`,
    async invoke(input, context, signal) {
      signal.throwIfAborted();
      const current = context.extensionContext.tools.find((tool) => tool.name === definition.name);

      if (!current) throw new Error(`Nested tool is no longer available: ${definition.name}`);
      const property = freeformInputProperty(current);

      const args: JsonObject =
        property === undefined
          ? functionArguments(definition.name, input)
          : input === undefined
            ? {}
            : { [property]: input };

      const outcome = await context.extensionContext.executeTool(definition.name, args, {
        signal,
        onUpdate: (update) => context.onUpdate?.(update),
      });

      context.captureResult?.(outcome.result, outcome.toolCall.id);

      if (outcome.result.terminate)
        throw new Error(`Nested tool ${definition.name} cannot terminate the Pi turn`);

      if (outcome.isError)
        throw new Error(resultText(outcome.result) || `Nested tool ${definition.name} failed`);

      if (current.outputSchema !== undefined) {
        if (outcome.result.structuredContent === undefined)
          throw new Error(`Nested tool ${definition.name} returned no structured content`);

        if (!Value.Check(current.outputSchema, outcome.result.structuredContent))
          throw new Error(`Nested tool ${definition.name} returned invalid structured content`);

        return outcome.result.structuredContent;
      }

      return nestedResultValue(outcome.result);
    },
  };
};

const functionArguments = (name: string, input: JsonValue | undefined): JsonObject => {
  if (!Value.Check(JsonObjectSchema, input)) throw new TypeError(`Invalid arguments for ${name}`);

  return input;
};

const freeformInputProperty = (definition: ToolMetadata): string | undefined => {
  const grammar = resolveGrammarConstrainedSampling(definition, true);

  if (!grammar) return undefined;
  const schema = definition.parameters;

  if (
    !isRecord(schema) ||
    !isRecord(schema.properties) ||
    Object.keys(schema.properties).length !== 1
  )
    throw new Error(`Grammar-constrained tool ${definition.name} must have one string parameter`);

  return grammar.inputProperty;
};

const codeModeName = (name: string, namespace?: string): string => {
  const qualified =
    namespace === undefined || namespace === "functions"
      ? name
      : namespace.endsWith("_") || name.startsWith("_")
        ? `${namespace}${name}`
        : `${namespace}__${name}`;

  return (
    Array.from(qualified, (character, index) =>
      (index === 0 ? /[a-zA-Z_$]/u : /[a-zA-Z0-9_$]/u).test(character) ? character : "_",
    ).join("") || "_"
  );
};

const resultText = (result: RuntimeToolResult): string =>
  result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");

const nestedResultValue = (result: RuntimeToolResult) => {
  const image = result.content.find((item) => item.type === "image");

  if (image?.type === "image") {
    assertSupportedImageMimeType(image.mimeType);

    return { detail: "high", image_url: `data:${image.mimeType};base64,${image.data}` };
  }

  return resultText(result) || "(no output)";
};

const toCodeModeToolResult = (response: RuntimeResponse) => {
  const scriptError = response.kind === "result" ? response.errorText : undefined;
  const hasScriptError = Boolean(scriptError);

  const output = response.contentItems
    .map(toPiContent)
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const maxChars =
    Math.min(
      MAX_CODE_MODE_OUTPUT_TOKENS,
      Math.max(1, response.maxOutputTokens ?? DEFAULT_CODE_MODE_OUTPUT_TOKENS),
    ) * 4;

  return {
    content: [
      {
        text: hasScriptError
          ? `Script error: ${scriptError}`
          : response.kind === "terminated"
            ? "Script terminated"
            : "Script completed",
        type: "text" as const,
      },
      ...truncateTextContent(output, maxChars),
    ],
    details: {
      cellId: response.cellId,
      codeMode: true,
      elapsedMs: response.elapsedMs,
      status: response.kind,
      traces: response.traces,
      droppedTraceCount: response.droppedTraceCount,
      scriptError: hasScriptError ? scriptError : undefined,
    },
    ...(hasScriptError || response.kind === "terminated" ? { isError: true } : {}),
  };
};

export const toPiContent = (
  item: RuntimeContentItem,
):
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | undefined => {
  if (item.type === "input_text" && item.text !== undefined)
    return { text: item.text, type: "text" };

  if (item.type === "input_image" && item.image_url !== undefined) {
    const match = /^data:(?<mimeType>[^;,]+);base64,(?<data>.+)$/su.exec(item.image_url);

    if (match?.groups?.mimeType && match.groups.data) {
      const mimeType = match.groups.mimeType.toLowerCase();
      assertSupportedImageMimeType(mimeType);

      return { data: match.groups.data, mimeType, type: "image" };
    }
  }

  return undefined;
};

const assertSupportedImageMimeType = (mimeType: string): void => {
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType.toLowerCase()))
    throw new Error(
      `Unsupported Code Mode image type "${mimeType}". Use PNG, JPEG, GIF, or WebP; convert SVG to PNG first.`,
    );
};

const truncateTextContent = <
  T extends { type: "text"; text: string } | { type: "image"; data: string; mimeType: string },
>(
  content: T[],
  maxChars: number,
): T[] => {
  let remaining = maxChars;

  return content.flatMap((item) => {
    if (item.type !== "text") return [item];

    if (remaining <= 0) return [];

    if (item.text.length <= remaining) {
      remaining -= item.text.length;

      return [item];
    }

    const truncated = { ...item, text: `${item.text.slice(0, remaining)}\n[Output truncated]` };
    remaining = 0;

    return [truncated];
  });
};

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Foreign JSON schema properties are open records; reject arrays before inspecting the freeform contract.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
