import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const PROMPT = `Review this proposed verification rule for an OpenAI Fast-mode extension:

function verified(requested, reported, httpStatus) {
  return requested === "priority" && reported === "priority" && httpStatus === 200;
}

The extension uses Pi's native openai/openai-responses provider with ChatGPT
subscription authentication. A response may report priority, fast, default,
or no tier. Requests may succeed but be downgraded. Streams may end early.

Give a concise, practical code review: identify false positives and false
negatives, propose a safer verification function, and supply five meaningful
test cases. Distinguish requesting Fast, confirming the processing tier,
and measuring speed. Do not claim that successful HTTP status, estimated
costs, or a latency difference prove the tier. Keep the answer under 400 words.`;

const PayloadSchema = Type.Object(
  {
    model: Type.String(),
    service_tier: Type.Optional(Type.String()),
    reasoning: Type.Optional(
      Type.Object({ effort: Type.String() }, { additionalProperties: true }),
    ),
  },
  { additionalProperties: true },
);

const EventSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal("response.created"),
      Type.Literal("response.in_progress"),
      Type.Literal("response.completed"),
      Type.Literal("response.incomplete"),
      Type.Literal("response.failed"),
    ]),
    response: Type.Object(
      { service_tier: Type.Optional(Type.String()) },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

export const probeTier = async (
  runtime: ModelRuntime,
  model: Model<Api>,
  requested: "default" | "priority" | "fast",
  fetchResponse: typeof fetch = globalThis.fetch,
) => {
  if (
    model.provider !== "openai" ||
    model.api !== "openai-responses" ||
    model.baseUrl !== "https://api.openai.com/v1" ||
    !runtime.isUsingSubscription("openai")
  )
    throw new Error("Select an available native OpenAI subscription model.");

  let wire: { url: string; model: string; tier: string; reasoning: string | undefined } | undefined;
  let reported: string | undefined;
  let completed = false;
  let status: number | undefined;
  let requestId: string | undefined;
  let serverProcessingMs: string | undefined;
  let responseHeaderNames: string[] = [];
  const events: { event: string; reported: string | undefined }[] = [];
  const started = performance.now();

  const response = await runtime.completeSimple(
    model,
    { messages: [{ role: "user", content: PROMPT, timestamp: Date.now() }] },
    {
      maxRetries: 0,
      maxTokens: 4096,
      reasoning: "medium",
      signal: AbortSignal.timeout(240_000),
      onPayload: (payload) => {
        if (!Value.Check(PayloadSchema, payload))
          throw new Error("Unexpected native Responses payload.");

        return { ...payload, service_tier: requested };
      },
      fetch: async (input, init) => {
        const request = new Request(input instanceof Request ? input.clone() : input, init);
        const raw: unknown = JSON.parse(await request.text());
        const body = Value.Parse(PayloadSchema, raw);

        if (
          request.url !== "https://api.openai.com/v1/responses" ||
          request.method !== "POST" ||
          body.model !== model.id ||
          body.service_tier !== requested
        )
          throw new Error("Native request endpoint, model or tier changed before sending.");

        wire = {
          url: request.url,
          model: body.model,
          tier: body.service_tier,
          reasoning: body.reasoning?.effort,
        };

        // Observe the serialized request without changing native auth, headers or transport.
        const result = await fetchResponse(input, init);
        status = result.status;
        requestId = result.headers.get("x-request-id") ?? undefined;
        serverProcessingMs = result.headers.get("openai-processing-ms") ?? undefined;
        responseHeaderNames = [...result.headers.keys()].sort();

        return result;
      },
      onProviderStreamEvent: (event) => {
        if (!Value.Check(EventSchema, event)) return;
        events.push({ event: event.type, reported: event.response.service_tier });

        if (event.type !== "response.completed") return;
        completed = true;
        reported = event.response.service_tier;
      },
    },
  );

  const requestSucceeded =
    wire !== undefined &&
    completed &&
    status !== undefined &&
    status >= 200 &&
    status < 300 &&
    response.stopReason === "stop";

  return {
    model: model.id,
    requested,
    wire,
    status,
    requestId,
    serverProcessingMs,
    responseHeaderNames,
    events,
    reported,
    completed,
    stopReason: response.stopReason,
    errorMessage: response.errorMessage,
    responseId: response.responseId,
    tokens: response.usage,
    elapsedMs: Math.round(performance.now() - started),
    requestSucceeded,
    confirmedFast:
      requested !== "default" &&
      requestSucceeded &&
      (reported === "priority" || reported === "fast"),
    answer: response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  };
};
