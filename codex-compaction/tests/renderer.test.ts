import { describe, expect, it } from "vitest";

import { sha256Canonical } from "../checkpoint.js";
import { formatCheckpointEntry } from "../renderer.js";

const checkpoint = () => {
  const replacement = [
    {
      content: [{ text: "retained user", type: "input_text" }],
      role: "user",
      type: "message",
    },
    {
      encrypted_content: "SECRET_ENCRYPTED_CONTENT",
      id: "SECRET_COMPACTION_ID",
      type: "compaction",
    },
  ];
  return {
    identity: {
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      model: "gpt-5.6-sol",
      provider: "openai-codex",
    },
    phase: "pre-sampling",
    protocol: "openai-responses-compaction-v2",
    reason: "threshold",
    replacement,
    replacementSha256: sha256Canonical(replacement),
    response: {
      id: "SECRET_RESPONSE_ID",
      usage: {
        cacheRead: 30,
        cacheWrite: 40,
        input: 100,
        output: 20,
        totalTokens: 120,
      },
    },
    schema: "clanker.codex-compaction/checkpoint",
    sourceTokens: 12_345,
    version: 4,
  };
};

describe("checkpoint entry renderer", () => {
  it("displays compact metrics and discloses no checkpoint internals", () => {
    const display = formatCheckpointEntry(checkpoint());
    const malformed = formatCheckpointEntry({
      encrypted_content: "SECRET_MALFORMED",
      version: 9,
    });

    expect({
      display,
      malformed,
      sensitiveValuesPresent: [
        "SECRET_ENCRYPTED_CONTENT",
        "SECRET_COMPACTION_ID",
        "SECRET_RESPONSE_ID",
      ].filter((value) => display?.includes(value)),
    }).toStrictEqual({
      display:
        "OpenAI Codex checkpoint · gpt-5.6-sol\npre-sampling · threshold · 12345 source tokens → ~47 replacement tokens\n100 input · 20 output · 30 cache read · 40 cache write · 120 total",
      malformed: undefined,
      sensitiveValuesPresent: [],
    });
  });
});
