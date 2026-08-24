import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFallbackAssistantIdMap,
  correctFallbackAssistantIds,
  hasMarkerFreeStructuralParity,
} from "../lifecycle.js";
import {
  extractFinalizedFrame,
  FRAME_MARKER_PREFIX,
  ResponsesInputItemSchema,
  rewriteFramedInput,
} from "../replay.js";
import type { ResponsesInputItem } from "../replay.js";
import { SPIKE_MODEL } from "./fixtures.js";

const NONZERO_USAGE: Usage = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
    total: 0,
  },
  input: 1,
  output: 1,
  totalTokens: 2,
};
const ALLOWED_TOOL_CALL_PROVIDERS = new Set([
  "openai",
  "openai-codex",
  "opencode",
  "azure-openai-responses",
]);
const ResponsesInputSchema = Type.Array(ResponsesInputItemSchema);

const assistant = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage => ({
  api: SPIKE_MODEL.api,
  content,
  model: SPIKE_MODEL.id,
  provider: SPIKE_MODEL.provider,
  role: "assistant",
  stopReason,
  timestamp: 2,
  usage: NONZERO_USAGE,
});

const marker = (edge: "end" | "start", nonce: string): Message => ({
  content: `${FRAME_MARKER_PREFIX}${edge}:${nonce}]`,
  role: "user",
  timestamp: 1,
});

const serialize = (messages: readonly Message[]): ResponsesInputItem[] =>
  Value.Parse(
    ResponsesInputSchema,
    structuredClone(
      convertResponsesMessages(
        SPIKE_MODEL,
        { messages: [...messages] },
        ALLOWED_TOOL_CALL_PROVIDERS,
        { includeSystemPrompt: false },
      ),
    ),
  );

const replacement: ResponsesInputItem[] = [
  {
    content: [{ text: "retained", type: "input_text" }],
    role: "user",
    type: "message",
  },
  {
    encrypted_content: "opaque",
    id: "cmp_current",
    type: "compaction",
  },
];

const assertMarkerFreeParity = (live: readonly Message[]) => {
  const nonce = "phase-four";
  const markerful = serialize([marker("start", nonce), ...live, marker("end", nonce)]);
  const logical = serialize(live);
  const extracted = extractFinalizedFrame(markerful, nonce);
  expect(extracted.kind).toBe("ok");
  if (extracted.kind !== "ok") {
    return;
  }
  const mapping = buildFallbackAssistantIdMap(markerful, logical);
  expect(hasMarkerFreeStructuralParity(markerful, logical, nonce, mapping)).toBeTruthy();
  const corrected = correctFallbackAssistantIds(
    rewriteFramedInput(extracted, replacement),
    mapping,
  );
  expect(corrected).toStrictEqual([...replacement, ...logical]);
};

describe("pinned marker-free fallback assistant ID parity", () => {
  const splitCall = assistant(
    [
      {
        arguments: { path: "split.txt" },
        id: "call_split|fc_split",
        name: "read_file",
        type: "toolCall",
      },
    ],
    "toolUse",
  );
  const splitResult: Message = {
    content: [{ text: "real split result", type: "text" }],
    isError: false,
    role: "toolResult",
    timestamp: 3,
    toolCallId: "call_split",
    toolName: "read_file",
  };

  it("quantifies a +1 framed shift and +2 suffix shift", () => {
    const nonce = "offsets";
    const prefix: Message = {
      content: "prefix",
      role: "user",
      timestamp: 1,
    };
    const framed = assistant([{ text: "framed", type: "text" }]);
    const suffix = assistant([{ text: "suffix", type: "text" }]);
    const markerful = serialize([
      prefix,
      marker("start", nonce),
      framed,
      marker("end", nonce),
      suffix,
    ]);
    const logical = serialize([prefix, framed, suffix]);

    expect(buildFallbackAssistantIdMap(markerful, logical)).toStrictEqual({
      msg_pi_2: "msg_pi_1",
      msg_pi_4: "msg_pi_2",
    });
  });

  it.each([
    {
      live: [assistant([{ text: "fallback", type: "text" }])],
      name: "active replay with fallback assistant text",
    },
    {
      live: [
        assistant([
          {
            text: "native",
            textSignature: JSON.stringify({ id: "msg_native", v: 1 }),
            type: "text",
          },
        ]),
      ],
      name: "native assistant ID",
    },
    {
      live: [
        assistant(
          [
            {
              arguments: { path: "README.md" },
              id: "call_1|fc_1",
              name: "read_file",
              type: "toolCall",
            },
          ],
          "toolUse",
        ),
        {
          content: [{ text: "contents", type: "text" }],
          isError: false,
          role: "toolResult",
          timestamp: 3,
          toolCallId: "call_1",
          toolName: "read_file",
        },
      ],
      name: "tool call and result linkage",
    },
    {
      live: [
        assistant([
          {
            thinking: "reasoning",
            thinkingSignature: JSON.stringify({
              encrypted_content: "encrypted-reasoning",
              id: "rs_1",
              summary: [],
              type: "reasoning",
            }),
            type: "thinking",
          },
          { text: "answer", type: "text" },
        ]),
      ],
      name: "reasoning signature",
    },
    {
      live: [],
      name: "overflow retry with no live assistant",
    },
  ] satisfies { live: Message[]; name: string }[])(
    "matches marker-free logical replacement for $name",
    ({ live }) => {
      expect.hasAssertions();
      assertMarkerFreeParity(live);
    },
  );

  it("keeps marker-free fallback identity through repeated replacement", () => {
    expect.hasAssertions();
    assertMarkerFreeParity([assistant([{ text: "before repeated compaction", type: "text" }])]);
    assertMarkerFreeParity([assistant([{ text: "after repeated compaction", type: "text" }])]);
  });

  it("detects a start marker splitting a prefix call from a framed result", () => {
    const nonce = "split-start";
    const markerful = serialize([
      splitCall,
      marker("start", nonce),
      splitResult,
      marker("end", nonce),
    ]);
    const logical = serialize([splitCall, splitResult]);
    const mapping = buildFallbackAssistantIdMap(markerful, logical);

    expect({
      markerSynthesizedOutput: JSON.stringify(markerful).includes("No result provided"),
      parity: hasMarkerFreeStructuralParity(markerful, logical, nonce, mapping),
    }).toStrictEqual({
      markerSynthesizedOutput: true,
      parity: false,
    });
  });

  it("detects an end marker splitting a framed call from a suffix result", () => {
    const nonce = "split-end";
    const markerful = serialize([
      marker("start", nonce),
      splitCall,
      marker("end", nonce),
      splitResult,
    ]);
    const logical = serialize([splitCall, splitResult]);
    const mapping = buildFallbackAssistantIdMap(markerful, logical);

    expect({
      markerSynthesizedOutput: JSON.stringify(markerful).includes("No result provided"),
      parity: hasMarkerFreeStructuralParity(markerful, logical, nonce, mapping),
    }).toStrictEqual({
      markerSynthesizedOutput: true,
      parity: false,
    });
  });

  it("fails closed instead of rewriting a native-ID collision", () => {
    expect(() =>
      correctFallbackAssistantIds(
        [
          {
            content: [],
            id: "msg_pi_1",
            role: "assistant",
            type: "message",
          },
          {
            content: [],
            id: "msg_pi_1",
            role: "assistant",
            type: "message",
          },
        ],
        { msg_pi_1: "msg_pi_0" },
      ),
    ).toThrow("ambiguous");
  });
});
