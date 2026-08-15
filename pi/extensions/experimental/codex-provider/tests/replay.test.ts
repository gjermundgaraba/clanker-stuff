import { describe, expect, it } from "vitest";

import { RETAINED_USER_IMAGE_PLACEHOLDER } from "../checkpoint.js";
import {
  CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
  FIXED_IMAGE_BYTE_ESTIMATE,
  NON_VISION_USER_IMAGE_PLACEHOLDER,
  buildCheckpointReplacement,
  buildTransientCheckpointReplacement,
  contextWindowDecision,
  estimateModelVisibleTokens,
  extractFinalizedFrame,
  frameContiguousBaseline,
  frameMarkerText,
  normalizeToolHistory,
  omitUnsupportedUserImages,
  rewriteFramedInput,
  shouldAutoCompact,
  shrinkTrailingOutputs,
  syntheticOutputId,
  tokensForUtf8,
  truncateMiddleToTokenBudget,
} from "../replay.js";

const compaction = (encryptedContent = "enc_new") => ({
  encrypted_content: encryptedContent,
  type: "compaction",
});

const image = (imageUrl = "data:image/png;base64,AA") => ({
  image_url: imageUrl,
  type: "input_image",
});

const user = (
  content: readonly (
    | ReturnType<typeof image>
    | {
        text: string;
        type: string;
      }
  )[]
) => ({
  content,
  role: "user",
  type: "message",
});

const textUser = (text: string) => user([{ text, type: "input_text" }]);

const agentMessage = (text: string) => ({
  author: "assistant",
  content: [{ text, type: "input_text" }],
  recipient: "user",
  type: "agent_message",
});

const serializedMarker = (edge: "end" | "start", nonce: string) =>
  textUser(frameMarkerText(edge, nonce));

const canOmitAssistantError = (message: {
  role: string;
  stopReason?: string;
}) => message.role === "assistant" && message.stopReason === "error";

describe("request framing and finalized replay", () => {
  it("frames one baseline while preserving fresh prefix/suffix and removes the lifecycle marker", () => {
    const prefix = { content: "fresh prefix", role: "user" };
    const marker = {
      content: "portable checkpoint summary",
      role: "compactionSummary",
    };
    const oldBaseline = { content: "old baseline", role: "user" };
    const liveTail = { content: "live tail", role: "user" };
    const suffix = { content: "fresh suffix", role: "user" };
    const start = { content: "START", role: "user" };
    const end = { content: "END", role: "user" };
    const framed = frameContiguousBaseline(
      [prefix, marker, oldBaseline, liveTail, suffix],
      [marker, oldBaseline, liveTail],
      [liveTail],
      start,
      end
    );
    if (framed.kind !== "ok") {
      throw new Error("Fixture did not frame");
    }

    const nonce = "0198abcd-0000-7000-8000-000000000000";
    const extracted = extractFinalizedFrame(
      [
        textUser("fresh prefix"),
        serializedMarker("start", nonce),
        textUser("live tail"),
        serializedMarker("end", nonce),
        textUser("fresh suffix"),
      ],
      nonce
    );
    if (extracted.kind !== "ok") {
      throw new Error("Fixture markers did not extract");
    }
    const rewritten = rewriteFramedInput(extracted, [
      { encrypted_content: "opaque", type: "compaction" },
    ]);

    expect({
      context: framed.messages,
      markerCount:
        JSON.stringify(rewritten).match(/codex-provider:frame/gu)?.length,
      opaqueCount: rewritten.filter((item) => item.type === "compaction")
        .length,
      replay: rewritten,
    }).toStrictEqual({
      context: [prefix, start, liveTail, end, suffix],
      markerCount: undefined,
      opaqueCount: 1,
      replay: [
        textUser("fresh prefix"),
        { encrypted_content: "opaque", type: "compaction" },
        textUser("live tail"),
        textUser("fresh suffix"),
      ],
    });
  });

  it("ignores unrelated marker-like text but rejects invalid current markers", () => {
    const nonce = "0198abcd-0000-7000-8000-000000000000";
    const stale = "0198abcd-0000-7000-8000-000000000001";
    const start = serializedMarker("start", nonce);
    const end = serializedMarker("end", nonce);
    const cases = [
      [],
      [start],
      [start, start, end],
      [start, end, end],
      [end, start],
    ];

    expect(
      cases.map((input) => extractFinalizedFrame(input, nonce).kind)
    ).toStrictEqual(["invalid", "invalid", "invalid", "invalid", "invalid"]);
    const malformed = textUser("[codex-provider:frame:start:not-a-uuid!]");
    const staleStart = serializedMarker("start", stale);
    const staleEnd = serializedMarker("end", stale);
    const unrelated = extractFinalizedFrame(
      [malformed, staleStart, start, textUser("body"), end, staleEnd],
      nonce
    );
    expect(unrelated).toStrictEqual({
      framed: [textUser("body")],
      kind: "ok",
      prefix: [malformed, staleStart],
      suffix: [staleEnd],
    });
  });

  it("matches semantically identical baseline objects with reordered keys", () => {
    const baseline = [
      {
        content: [{ text: "same", type: "text" }],
        role: "user",
        timestamp: 1,
      },
    ];
    const reordered = JSON.parse(
      '[{"timestamp":1,"role":"user","content":[{"type":"text","text":"same"}]}]'
    ) as typeof baseline;
    const start = {
      content: [{ text: "START", type: "text" }],
      role: "user",
      timestamp: 2,
    };
    const end = {
      content: [{ text: "END", type: "text" }],
      role: "user",
      timestamp: 3,
    };

    expect(
      frameContiguousBaseline(reordered, baseline, [], start, end)
    ).toStrictEqual({
      framed: [],
      kind: "ok",
      messages: [start, end],
      prefix: [],
      suffix: [],
    });
    expect(
      frameContiguousBaseline(
        [...reordered, ...reordered],
        baseline,
        [],
        start,
        end
      ).kind
    ).toBe("ambiguous");
  });

  it.each([
    ["user", { content: "same", role: "user" }],
    ["assistant", { content: [], role: "assistant", stopReason: "stop" }],
    [
      "toolResult",
      { content: [], role: "toolResult", toolCallId: "call", toolName: "read" },
    ],
    [
      "bashExecution",
      { command: "pwd", output: "/tmp", role: "bashExecution" },
    ],
    ["custom", { content: "same", customType: "test", role: "custom" }],
    [
      "branchSummary",
      { fromId: "entry", role: "branchSummary", summary: "same" },
    ],
    [
      "compactionSummary",
      { role: "compactionSummary", summary: "same", tokensBefore: 1 },
    ],
  ])("matches %s messages across top-level timestamp drift", (_role, value) => {
    const persisted = { ...value, timestamp: 1 };
    const live = { ...value, timestamp: 2 };
    const start = { content: "START", role: "user", timestamp: 3 };
    const end = { content: "END", role: "user", timestamp: 4 };
    const framed = frameContiguousBaseline(
      [live],
      [persisted],
      [persisted],
      start,
      end
    );

    expect(framed.kind).toBe("ok");
    if (framed.kind !== "ok") {
      throw new Error("Fixture did not frame");
    }
    expect(framed.framed[0]).toBe(live);
    expect(framed.messages).toStrictEqual([start, live, end]);
  });

  it("fails closed for non-timestamp drift and ambiguous timestamp-only duplicates", () => {
    const persisted = {
      content: "same",
      customType: "test",
      role: "custom",
      timestamp: 1,
    };
    const changed = { ...persisted, content: "changed", timestamp: 2 };
    const duplicate = { ...persisted, timestamp: 3 };
    const marker = { content: "marker", role: "user", timestamp: 4 };

    expect(
      frameContiguousBaseline(
        [changed],
        [persisted],
        [persisted],
        marker,
        marker
      ).kind
    ).toBe("missing");
    expect(
      frameContiguousBaseline(
        [persisted, duplicate],
        [persisted],
        [persisted],
        marker,
        marker
      ).kind
    ).toBe("ambiguous");
  });

  it("aligns persisted retry errors without reintroducing them into the live segment", () => {
    const history = { content: "history", role: "user" };
    const firstError = {
      content: [{ text: "partial one", type: "thinking" }],
      role: "assistant",
      stopReason: "error",
      timestamp: 1,
    };
    const secondError = {
      content: [{ text: "partial two", type: "thinking" }],
      role: "assistant",
      stopReason: "error",
      timestamp: 2,
    };
    const retried = {
      content: [{ text: "retry", type: "toolCall" }],
      role: "assistant",
      stopReason: "toolUse",
      timestamp: 3,
    };
    const result = {
      content: [{ text: "result", type: "text" }],
      role: "toolResult",
      timestamp: 4,
    };
    const start = { content: "START", role: "user" };
    const end = { content: "END", role: "user" };
    const baseline = [history, firstError, secondError, retried, result];
    const segment = [firstError, secondError, retried, result];
    const aligned = frameContiguousBaseline(
      [history, retried, result],
      baseline,
      segment,
      start,
      end,
      canOmitAssistantError
    );
    const retained = frameContiguousBaseline(
      baseline,
      baseline,
      segment,
      start,
      end,
      canOmitAssistantError
    );

    expect({ aligned, retained }).toStrictEqual({
      aligned: {
        framed: [retried, result],
        kind: "ok",
        messages: [start, retried, result, end],
        prefix: [],
        suffix: [],
      },
      retained: {
        framed: segment,
        kind: "ok",
        messages: [start, ...segment, end],
        prefix: [],
        suffix: [],
      },
    });
  });
});

describe("replacement and token policy", () => {
  it("retains bounded non-final agent messages in source order", () => {
    const result = buildCheckpointReplacement(
      [
        textUser("user"),
        agentMessage("kept"),
        agentMessage("Message Type: FINAL_ANSWER\nfinished"),
        agentMessage("x".repeat(40_004)),
      ],
      compaction()
    );

    expect(result.map((item) => item.type)).toStrictEqual([
      "message",
      "agent_message",
      "compaction",
    ]);
  });

  it("retains newest users at the exact 64K policy and replaces old opaque state", () => {
    const exactBudget = textUser("x".repeat(64_000 * 4));
    const first = buildCheckpointReplacement(
      [textUser("old"), exactBudget],
      compaction("enc_first")
    );
    const repeated = buildCheckpointReplacement(
      first.filter((item) => item.type === "message"),
      compaction("enc_second")
    );

    expect({
      encryptedItems: repeated
        .filter((item) => item.type === "compaction")
        .map((item) => item.encrypted_content),
      finalType: repeated.at(-1)?.type,
      retainedTexts: repeated
        .filter((item) => item.type === "message")
        .flatMap((item) =>
          item.content
            .filter((content) => content.type === "input_text")
            .map((content) => content.text.length)
        ),
    }).toStrictEqual({
      encryptedItems: ["enc_second"],
      finalType: "compaction",
      retainedTexts: [256_000],
    });
  });

  it("bounds middle truncation while keeping images transient only", () => {
    const boundary = buildCheckpointReplacement(
      [textUser("old-old"), textUser("middle1234"), textUser("new")],
      compaction(),
      3
    );
    const imageOnly = user([image()]);
    const imageResult = buildCheckpointReplacement(
      [textUser("old"), imageOnly, textUser("new")],
      compaction(),
      100
    );
    const transientImageResult = buildTransientCheckpointReplacement(
      [textUser("old"), imageOnly, textUser("new")],
      compaction(),
      2
    );
    const budgetedImageResult = buildTransientCheckpointReplacement(
      [imageOnly],
      compaction(),
      Math.ceil(FIXED_IMAGE_BYTE_ESTIMATE / 4)
    );
    const hugeImageResult = buildCheckpointReplacement(
      [user([image(`data:image/png;base64,${"A".repeat(2_000_000)}`)])],
      compaction(),
      100
    );
    expect(JSON.stringify(hugeImageResult).length).toBeLessThan(1000);
    const unicode = truncateMiddleToTokenBudget(
      "😀😀😀😀😀😀😀😀😀😀\nsecond line with text\n",
      8
    );
    const zeroBudget = truncateMiddleToTokenBudget("abcdef", 0);

    expect({
      boundary,
      budgetedImageResult,
      imageOnly: imageResult,
      persistedImageData:
        JSON.stringify(imageResult).includes("data:image/png"),
      transientImageResult,
      unicode,
      unicodeTokens: tokensForUtf8(unicode),
      zeroBudget,
    }).toStrictEqual({
      boundary: [textUser("new"), compaction()],
      budgetedImageResult: [imageOnly, compaction()],
      imageOnly: [
        textUser("old"),
        textUser(RETAINED_USER_IMAGE_PLACEHOLDER),
        textUser("new"),
        compaction(),
      ],
      persistedImageData: false,
      transientImageResult: [textUser("new"), compaction()],
      unicode: "…15 tokens truncated…ext\n",
      unicodeTokens: 8,
      zeroBudget: "",
    });
  });

  it("estimates model-visible bytes safely and applies 90/95 percent boundaries", () => {
    const shortImage = user([image("data:image/png;base64,AA")]);
    const hugeImage = user([
      image(`data:image/png;base64,${"A".repeat(100_000)}`),
    ]);
    const shortEstimate = estimateModelVisibleTokens("instructions", [
      shortImage,
    ]);
    const hugeEstimate = estimateModelVisibleTokens("instructions", [
      hugeImage,
    ]);

    expect({
      decisions: contextWindowDecision(1000),
      fractionalUnavailable: contextWindowDecision(1000.5),
      imageEstimatesMatch: shortEstimate === hugeEstimate,
      instructionsIncluded:
        shortEstimate > estimateModelVisibleTokens("", [shortImage]),
      nonFiniteUnavailable: contextWindowDecision(Number.POSITIVE_INFINITY),
      triggerAtBoundary: shouldAutoCompact(900, 1000),
    }).toStrictEqual({
      decisions: { autoCompactTokens: 900, effectiveWindowTokens: 950 },
      fractionalUnavailable: undefined,
      imageEstimatesMatch: true,
      instructionsIncluded: true,
      nonFiniteUnavailable: undefined,
      triggerAtBoundary: true,
    });
  });

  it("omits unsupported user images with Pi's placeholder and preserves supported images", () => {
    const input = [
      user([
        image("data:image/png;base64,SECRET_ONE"),
        image("data:image/png;base64,SECRET_TWO"),
        { text: "visible", type: "input_text" },
        image("data:image/png;base64,SECRET_THREE"),
      ]),
    ];
    const supported = omitUnsupportedUserImages(input, true);
    const unsupported = omitUnsupportedUserImages(input, false);

    expect({
      supported,
      supportedIdentity: supported === input,
      unsupported,
      unsupportedContainsBase64:
        JSON.stringify(unsupported).includes("SECRET_"),
    }).toStrictEqual({
      supported: input,
      supportedIdentity: true,
      unsupported: [
        user([
          {
            text: NON_VISION_USER_IMAGE_PLACEHOLDER,
            type: "input_text",
          },
          { text: "visible", type: "input_text" },
          {
            text: NON_VISION_USER_IMAGE_PLACEHOLDER,
            type: "input_text",
          },
        ]),
      ],
      unsupportedContainsBase64: false,
    });
  });
});

describe("tool history normalization", () => {
  it("removes orphan/duplicate outputs and deterministically repairs supported calls", () => {
    const existingOutput = {
      call_id: "call-existing",
      id: "output-existing",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
      output: "first",
      type: "function_call_output",
    };
    const input = [
      { call_id: "orphan", output: "remove", type: "function_call_output" },
      {
        arguments: "{}",
        call_id: "call-function",
        id: "item_fc",
        name: "run",
        type: "function_call",
      },
      {
        arguments: "{}",
        call_id: "call-existing",
        id: "item_existing",
        name: "run",
        type: "function_call",
      },
      existingOutput,
      {
        call_id: "call-existing",
        id: "duplicate",
        output: "remove duplicate",
        type: "function_call_output",
      },
      {
        call_id: "call-custom",
        id: "item_custom",
        input: "input",
        name: "custom",
        type: "custom_tool_call",
      },
      {
        action: {},
        call_id: "call-shell",
        id: "item_shell",
        status: "completed",
        type: "local_shell_call",
      },
      {
        arguments: {},
        call_id: "call-search",
        execution: "client",
        id: "item_search",
        type: "tool_search_call",
      },
      {
        arguments: {},
        call_id: "server-search",
        execution: "server",
        id: "item_server",
        type: "tool_search_call",
      },
    ];

    const normalized = normalizeToolHistory(input);
    expect({
      deterministic: syntheticOutputId("fco", "item_fc"),
      existingIdentityPreserved: normalized.includes(existingOutput),
      outputs: normalized
        .filter((item) => String(item.type).endsWith("_output"))
        .map((item) => ({
          callId: item.call_id,
          id: item.id,
          metadata: item.internal_chat_message_metadata_passthrough,
          output: item.output,
          tools: item.tools,
          type: item.type,
        })),
      stableOnSecondPass: normalizeToolHistory(normalized),
    }).toStrictEqual({
      deterministic: "fco_5d106b74-fea6-5e0c-8380-fc782a2f6673",
      existingIdentityPreserved: true,
      outputs: [
        {
          callId: "call-function",
          id: "fco_5d106b74-fea6-5e0c-8380-fc782a2f6673",
          metadata: undefined,
          output: "aborted",
          tools: undefined,
          type: "function_call_output",
        },
        {
          callId: "call-existing",
          id: "output-existing",
          metadata: { turn_id: "turn-1" },
          output: "first",
          tools: undefined,
          type: "function_call_output",
        },
        {
          callId: "call-custom",
          id: "ctco_4a73809a-b4e7-5b9b-9cbe-f3cf36d45123",
          metadata: undefined,
          output: "aborted",
          tools: undefined,
          type: "custom_tool_call_output",
        },
        {
          callId: "call-shell",
          id: "fco_3dd63aec-3392-525f-bdfa-1997acaabf40",
          metadata: undefined,
          output: "aborted",
          tools: undefined,
          type: "function_call_output",
        },
        {
          callId: "call-search",
          id: "tso_60f126ef-c2b9-5a32-bbad-fae23c356a0b",
          metadata: undefined,
          output: undefined,
          tools: [],
          type: "tool_search_output",
        },
      ],
      stableOnSecondPass: normalized,
    });
  });
});

describe("trailing output shrinking", () => {
  it("rewrites only a recognized contiguous suffix newest-first", () => {
    const oldOutput = {
      call_id: "old",
      id: "old-output",
      output: "old output must survive",
      type: "function_call_output",
    };
    const marker = textUser("stop at this non-output");
    const suffix = [
      {
        call_id: "function",
        id: "function-output",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-2" },
        output: "x".repeat(1000),
        type: "function_call_output",
      },
      {
        call_id: "custom",
        id: "custom-output",
        name: "custom",
        output: { body: "y".repeat(1000), success: false },
        type: "custom_tool_call_output",
      },
      {
        call_id: "search",
        execution: "client",
        id: "search-output",
        status: "completed",
        tools: [{ description: "z".repeat(1000), name: "tool" }],
        type: "tool_search_output",
      },
    ];
    const input = [oldOutput, marker, ...suffix];
    const shrunk = shrinkTrailingOutputs(input, "instructions", 0);
    const newestOnlyInput = [
      oldOutput,
      marker,
      suffix[0],
      suffix[1],
      { ...suffix[2], tools: [] },
    ];
    const newestOnlyLimit = estimateModelVisibleTokens(
      "instructions",
      newestOnlyInput
    );
    const newestOnly = shrinkTrailingOutputs(
      input,
      "instructions",
      newestOnlyLimit
    );

    expect({
      custom: shrunk.at(-2),
      function: shrunk.at(-3),
      newestOnlyChanged: newestOnly.at(-1)?.tools,
      oldIdentityPreserved: shrunk[0] === oldOutput,
      search: shrunk.at(-1),
    }).toStrictEqual({
      custom: {
        ...suffix[1],
        output: {
          body: CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
          success: false,
        },
      },
      function: {
        ...suffix[0],
        output: CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
      },
      newestOnlyChanged: [],
      oldIdentityPreserved: true,
      search: { ...suffix[2], tools: [] },
    });
  });
});
