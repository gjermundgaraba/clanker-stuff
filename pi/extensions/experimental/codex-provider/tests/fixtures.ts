import { openaiCodexProvider } from "#pi-openai-codex";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

export const WireRecordSchema = Type.Record(Type.String(), Type.Unknown());

export type WireRecord = Static<typeof WireRecordSchema>;

const WireArraySchema = Type.Array(Type.Unknown());

const StringValueSchema = Type.String();

export const wireRecord = (value: unknown): WireRecord => Value.Parse(WireRecordSchema, value);

export const wireArray = (value: unknown): unknown[] => Value.Parse(WireArraySchema, value);

export const wireRecords = (value: unknown): WireRecord[] => wireArray(value).map(wireRecord);

export const wireString = (value: unknown): string => Value.Parse(StringValueSchema, value);

type MockUiContext = Pick<ExtensionUIContext, "notify" | "setStatus"> &
  Partial<Pick<ExtensionUIContext, "select">>;

export const mockUiContext = async (context: MockUiContext): Promise<ExtensionUIContext> => {
  const host = createExtensionHost(() => {});
  await host.ready;

  return host.createContext({ ui: context }).ui;
};

export type SessionEntryPayload<Entry = SessionEntry> = Entry extends SessionEntry
  ? Omit<Entry, "id" | "parentId" | "timestamp">
  : never;

type Mutable<Payload> = { -readonly [Key in keyof Payload]: Payload[Key] };

export const sessionEntry = <const Payload extends SessionEntryPayload>(
  id: string,
  value: Payload,
  parentId: string | null = null,
  timestamp = "2026-07-30T12:00:00.000Z",
): Mutable<Payload> & { id: string; parentId: string | null; timestamp: string } => ({
  ...value,
  id,
  parentId,
  timestamp,
});

export const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

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

const jwtPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

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
  compat: { supportsOpenAIGrammarTools: true, supportsAdditionalTools: true },
  id: "gpt-5.6-terra",
  input: ["text"],
  maxTokens: 16_384,
  name: "Phase Zero Codex",
  provider: "openai-codex",
  reasoning: true,
} satisfies Model<"openai-codex-responses">;

export const createToolsModel = (
  id: string,
  grammar = false,
  overrides: { api?: Api; provider?: string } = {},
): Model<Api> => ({
  ...SPIKE_MODEL,
  compat: { supportsOpenAIGrammarTools: grammar, supportsAdditionalTools: true },
  id,
  name: id,
  ...overrides,
});

// A Pi catalog dependency with future definitions, not remote authority inventing base fields.
export const builtinWithModels = (...models: Model<"openai-codex-responses">[]) => {
  const builtin = openaiCodexProvider();

  return { ...builtin, getModels: () => [...builtin.getModels(), ...models] };
};
