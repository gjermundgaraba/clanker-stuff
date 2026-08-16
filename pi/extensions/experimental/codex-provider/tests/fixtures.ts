import type { Api, Model } from "@earendil-works/pi-ai";

export const sse = (events: readonly unknown[]) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } }
  );

export const responseEvents = (id: string, text: string, endTurn?: boolean) => {
  const message = {
    content: [{ annotations: [], text, type: "output_text" }],
    id: `msg_${id}`,
    role: "assistant",
    status: "completed",
    type: "message",
  };
  return [
    { response: { id, status: "in_progress" }, type: "response.created" },
    {
      item: { ...message, content: [], status: "in_progress" },
      output_index: 0,
      type: "response.output_item.added",
    },
    {
      content_index: 0,
      delta: text,
      output_index: 0,
      type: "response.output_text.delta",
    },
    { item: message, output_index: 0, type: "response.output_item.done" },
    {
      response: {
        end_turn: endTurn,
        id,
        output: [message],
        status: "completed",
        usage: {
          input_tokens: 8,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 10,
        },
      },
      type: "response.done",
    },
  ];
};

const jwtPart = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export const makeCodexApiKey = (accountId: string): string =>
  `${jwtPart({ alg: "none", typ: "JWT" })}.${jwtPart({
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
    },
  })}.signature`;

export const SPIKE_API_KEY = makeCodexApiKey("phase-zero-account");

export const SPIKE_MODEL = {
  api: "openai-codex-responses",
  baseUrl: "https://phase-zero.invalid/backend-api",
  contextWindow: 272_000,
  cost: {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
  },
  id: "gpt-5.6-phase-zero",
  input: ["text"],
  maxTokens: 16_384,
  name: "Phase Zero Codex",
  provider: "openai-codex",
  reasoning: true,
} satisfies Model<"openai-codex-responses">;

export const createToolsModel = (
  id: string,
  grammar = false,
  overrides: { api?: Api; provider?: string } = {}
): Model<Api> => ({
  ...SPIKE_MODEL,
  compat: grammar ? { supportsOpenAIGrammarTools: true } : undefined,
  id,
  name: id,
  ...overrides,
});
