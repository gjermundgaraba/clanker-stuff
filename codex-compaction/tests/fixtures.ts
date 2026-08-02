import type { Model } from "@earendil-works/pi-ai";

const jwtPart = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export const SPIKE_API_KEY = `${jwtPart({ alg: "none", typ: "JWT" })}.${jwtPart(
  {
    "https://api.openai.com/auth": {
      chatgpt_account_id: "phase-zero-account",
    },
  }
)}.signature`;

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
  id: "phase-zero-codex",
  input: ["text"],
  maxTokens: 16_384,
  name: "Phase Zero Codex",
  provider: "openai-codex",
  reasoning: true,
} satisfies Model<"openai-codex-responses">;
