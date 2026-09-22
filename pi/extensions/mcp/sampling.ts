import { sumUsages } from "@clanker-stuff/code-mode-tools";
import type { Api, Context, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CreateMessageRequestParams, CreateMessageResult } from "@modelcontextprotocol/client";
import type { SamplingEvents, SamplingScope, SamplingScopeRequest } from "./sampling-protocol.js";

export interface SamplingUsage {
  usage?: Usage;
  complete: boolean;
  model: string;
}

export const sample = async (
  pi: Pick<ExtensionAPI, "events">,
  ctx: ExtensionContext,
  model: Model<Api> | undefined,
  params: CreateMessageRequestParams,
  signal: AbortSignal,
  report: (usage: SamplingUsage) => void,
): Promise<CreateMessageResult> => {
  signal.throwIfAborted();

  if (!model) throw new Error("MCP sampling requires a selected Pi model");

  if (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)
    throw new Error("MCP sampling maxTokens must be a positive safe integer");
  const maxTokens = Math.min(params.maxTokens, model.maxTokens);

  if (!(maxTokens > 0)) throw new Error("Selected model has no supported sampling output budget");

  if (params.tools?.length || params.toolChoice)
    throw new Error("MCP sampling does not support tools");

  if (params.stopSequences?.some((stop) => stop.length === 0))
    throw new Error("MCP sampling stopSequences must not contain empty strings");

  const messages: Context["messages"] = params.messages.map((message) => {
    const parts = Array.isArray(message.content) ? message.content : [message.content];

    if (parts.some((part) => part.type !== "text"))
      throw new Error("MCP sampling supports text input only");
    const text = parts.map((part) => (part.type === "text" ? part.text : "")).join("\n");

    return message.role === "assistant"
      ? {
          role: "assistant",
          content: [{ type: "text", text }],
          provider: model.provider,
          model: model.id,
          api: model.api,
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }
      : { role: "user", content: text, timestamp: Date.now() };
  });

  let pending: Promise<SamplingScope> | undefined;
  pi.events.emit(
    "clanker-codex:sampling-scope-request" satisfies keyof SamplingEvents,
    {
      model,
      maxTokens,
      resolve: (scope: Promise<SamplingScope>) => {
        pending = scope;
      },
    } satisfies SamplingScopeRequest,
  );

  if (!pending)
    throw new Error(
      `MCP sampling has no verified output-bound and disposal adapter for ${model.provider}/${model.id}`,
    );
  const scope = await pending;

  try {
    signal.throwIfAborted();

    const result = await scope.run(() =>
      ctx.modelRegistry.complete(
        model,
        {
          messages,
          ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
        },
        {
          signal,
          maxTokens,
          maxRetries: 0,
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        },
      ),
    );

    if (
      result.stopReason === "error" ||
      (result.stopReason === "aborted" && !scope.status.limitReached)
    ) {
      throw new Error(result.errorMessage ?? "MCP sampling failed");
    }

    signal.throwIfAborted();

    if (result.content.some((part) => part.type !== "text"))
      throw new Error("Sampling adapter returned unsupported content");
    let text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    let stopped = false;

    for (const stop of params.stopSequences ?? []) {
      const index = text.indexOf(stop);

      if (index >= 0) {
        text = text.slice(0, index);
        stopped = true;
      }
    }

    const bounded = scope.boundText(text);
    const conversionLimited = bounded !== text;

    return {
      role: "assistant",
      model: `${model.provider}/${model.id}`,
      content: { type: "text", text: bounded },
      stopReason: conversionLimited
        ? "maxTokens"
        : stopped
          ? "stopSequence"
          : scope.status.limitReached || result.stopReason === "length"
            ? "maxTokens"
            : "endTurn",
    };
  } finally {
    try {
      await scope.dispose();
    } finally {
      report({
        model: `${model.provider}/${model.id}`,
        ...(scope.status.usage !== undefined ? { usage: scope.status.usage } : {}),
        complete: scope.status.usageComplete,
      });
    }
  }
};

export const sumUsage = (samples: readonly SamplingUsage[]): Usage | undefined =>
  sumUsages(samples.flatMap(({ usage }) => (usage ? [usage] : [])));
