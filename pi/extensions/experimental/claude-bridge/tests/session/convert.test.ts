import { readFileSync } from "node:fs";

import type { Message } from "@earendil-works/pi-ai";
import { createSession, repairToolPairing } from "cc-session-io";
import type {
  ContentBlock,
  JsonlRecord,
  Message as SessionMessage,
  ToolResultBlock,
} from "cc-session-io";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import { toJsonObject } from "../../json.js";
import { convertPiMessages } from "../../session/convert.js";
import {
  assistant,
  image,
  offTypeBlock,
  text,
  thinking,
  toolCall,
  toolResult,
  user,
} from "./messages.js";

const MCP = "mcp__custom-tools__";

const convert = (messages: readonly Message[]): SessionMessage[] =>
  convertPiMessages(messages).anthropicMessages;

const toolUse = (
  id: string,
  name: string,
  input: unknown = {}
): ContentBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});

const resultBlock = (
  toolUseId: string,
  content: ToolResultBlock["content"],
  isError = false
): ContentBlock => ({
  type: "tool_result",
  tool_use_id: toolUseId,
  content,
  is_error: isError,
});

const toolResultBlocks = (
  messages: readonly SessionMessage[]
): ToolResultBlock[] =>
  messages
    .flatMap((message) =>
      typeof message.content === "string" ? [] : message.content
    )
    .flatMap((block) => (block.type === "tool_result" ? [block] : []));

const pngSource = {
  type: "base64",
  media_type: "image/png",
  data: "BASE64DATA",
} as const;

describe("tool ID sanitization", () => {
  it("rewrites Kimi-style ids with dots and colons on both halves of the pair", () => {
    expect(
      convert([
        assistant([toolCall("functions.bash:0", "bash", { cmd: "ls" })]),
        toolResult("functions.bash:0", "file.txt"),
      ])
    ).toStrictEqual([
      {
        role: "assistant",
        content: [toolUse("functions_bash_0", `${MCP}bash`, { cmd: "ls" })],
      },
      { role: "user", content: [resultBlock("functions_bash_0", "file.txt")] },
    ]);
  });

  it("rewrites spaces and special characters", () => {
    expect(
      convert([
        assistant([toolCall("tool call#1@foo", "bash")]),
        toolResult("tool call#1@foo", "ok"),
      ])
    ).toStrictEqual([
      {
        role: "assistant",
        content: [toolUse("tool_call_1_foo", `${MCP}bash`)],
      },
      { role: "user", content: [resultBlock("tool_call_1_foo", "ok")] },
    ]);
  });

  it("passes already-valid Anthropic ids through unchanged", () => {
    expect(
      convert([
        assistant([toolCall("toolu_abc123-XYZ", "read")]),
        toolResult("toolu_abc123-XYZ", "data"),
      ])
    ).toStrictEqual([
      {
        role: "assistant",
        content: [toolUse("toolu_abc123-XYZ", `${MCP}read`)],
      },
      { role: "user", content: [resultBlock("toolu_abc123-XYZ", "data")] },
    ]);
  });

  it("keeps tool_use and tool_result ids paired across several calls", () => {
    const ids = ["fn.read:0", "fn.write:1", "fn.bash:2"];

    const converted = convert(
      ids.flatMap((id) => [
        assistant([toolCall(id, "bash")]),
        toolResult(id, "ok"),
      ])
    );

    const useIds = converted
      .flatMap((message) =>
        typeof message.content === "string" ? [] : message.content
      )
      .flatMap((block) => (block.type === "tool_use" ? [block.id] : []));

    expect(useIds).toStrictEqual(["fn_read_0", "fn_write_1", "fn_bash_2"]);
    expect(
      toolResultBlocks(converted).map((block) => block.tool_use_id)
    ).toStrictEqual(useIds);
  });
});

describe("empty text block filtering", () => {
  it("drops an empty text block beside a tool call", () => {
    expect(
      convert([assistant([text(""), toolCall("abc", "read")])])
    ).toStrictEqual([
      { role: "assistant", content: [toolUse("abc", `${MCP}read`)] },
    ]);
  });

  it("replaces an assistant message holding only empty text with a placeholder", () => {
    expect(convert([assistant([text("")])])).toStrictEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "[incompatible content omitted]" }],
      },
    ]);
  });

  it("preserves non-empty text", () => {
    expect(convert([assistant([text("Hello world")])])).toStrictEqual([
      { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
    ]);
  });

  it("keeps only the non-empty blocks among several", () => {
    expect(
      convert([assistant([text(""), text("real content"), text("")])])
    ).toStrictEqual([
      { role: "assistant", content: [{ type: "text", text: "real content" }] },
    ]);
  });
});

describe("thinking block filtering", () => {
  it("drops thinking from another provider", () => {
    expect(
      convert([
        assistant([thinking("let me think..."), text("answer")], "openrouter"),
      ])
    ).toStrictEqual([
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]);
  });

  it("keeps signed thinking Claude Code produced", () => {
    expect(
      convert([assistant([thinking("reasoning...", "sig123"), text("answer")])])
    ).toStrictEqual([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning...", signature: "sig123" },
          { type: "text", text: "answer" },
        ],
      },
    ]);
  });

  // A signature minted by another provider isn't ours to replay into Claude Code's
  // session, so it is dropped even though the message is Anthropic's.
  it("drops signed thinking from pi's own Anthropic provider", () => {
    expect(
      convert([
        assistant([thinking("hmm", "sig456"), text("done")], "anthropic"),
      ])
    ).toStrictEqual([
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
  });

  it("drops unsigned thinking from the bridge", () => {
    expect(
      convert([assistant([thinking("no sig"), text("answer")])])
    ).toStrictEqual([
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]);
  });

  it("replaces a message holding only foreign thinking with a placeholder", () => {
    expect(
      convert([assistant([thinking("deep thoughts")], "deepseek")])
    ).toStrictEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "[incompatible content omitted]" }],
      },
    ]);
  });
});

describe("message structure", () => {
  it("converts a tool result into a user tool_result block", () => {
    expect(convert([toolResult("id1", "result text")])).toStrictEqual([
      { role: "user", content: [resultBlock("id1", "result text")] },
    ]);
  });

  it("keeps the error flag", () => {
    expect(convert([toolResult("id1", "oh no", true)])).toStrictEqual([
      { role: "user", content: [resultBlock("id1", "oh no", true)] },
    ]);
  });

  // Claude Code puts every result for one assistant turn in a single user message; see
  // the repairToolPairing tests below for why it matters.
  it("merges the results of a parallel tool call into one user message", () => {
    expect(
      convert([
        assistant([
          toolCall("t1", "read", { path: "a.txt" }),
          toolCall("t2", "read", { path: "b.txt" }),
        ]),
        toolResult("t1", "content a"),
        toolResult("t2", "content b"),
      ])
    ).toStrictEqual([
      {
        role: "assistant",
        content: [
          toolUse("t1", `${MCP}read`, { path: "a.txt" }),
          toolUse("t2", `${MCP}read`, { path: "b.txt" }),
        ],
      },
      {
        role: "user",
        content: [
          resultBlock("t1", "content a"),
          resultBlock("t2", "content b"),
        ],
      },
    ]);
  });

  it("does not merge results across an intervening user message", () => {
    const converted = convert([
      assistant([toolCall("t1", "read")]),
      toolResult("t1", "a"),
      user("keep going"),
      assistant([toolCall("t2", "read")]),
      toolResult("t2", "b"),
    ]);

    expect(converted.map((message) => message.role)).toStrictEqual([
      "assistant",
      "user",
      "user",
      "assistant",
      "user",
    ]);
    expect(
      toolResultBlocks(converted).map((block) => block.tool_use_id)
    ).toStrictEqual(["t1", "t2"]);
  });

  it("converts a mixed conversation, naming the call after the served tool", () => {
    expect(
      convert([
        user("read file.txt"),
        assistant([toolCall("call1", "read", { path: "file.txt" })]),
        toolResult("call1", "hello world"),
        assistant([text("The file says hello world.")]),
      ])
    ).toStrictEqual([
      { role: "user", content: "read file.txt" },
      {
        role: "assistant",
        content: [toolUse("call1", `${MCP}read`, { path: "file.txt" })],
      },
      { role: "user", content: [resultBlock("call1", "hello world")] },
      {
        role: "assistant",
        content: [{ type: "text", text: "The file says hello world." }],
      },
    ]);
  });

  it("keeps user string content", () => {
    expect(convert([user("hello")])).toStrictEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("replaces an empty user string with [empty]", () => {
    expect(convert([user("")])).toStrictEqual([
      { role: "user", content: "[empty]" },
    ]);
  });

  it("keeps user text blocks", () => {
    expect(convert([user([text("hi")])])).toStrictEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("replaces a user message with no content left with [empty]", () => {
    expect(convert([user([text("")])])).toStrictEqual([
      { role: "user", content: "[empty]" },
    ]);
  });

  // The same blocks a prompt gets: an image the API rejects would fail every later turn.
  it("marks a user image Claude cannot take", () => {
    expect(
      convert([user([text("look"), image("BASE64DATA", "image/tiff")])])
    ).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "text", text: "[image]" },
        ],
      },
    ]);
  });

  // The query runs with `tools: []`, so no name in the transcript may look like a Claude
  // Code builtin: that is what makes the model call one it cannot call. A tool pi ran
  // that is no longer served is still a pi tool.
  it("names every call in the MCP namespace, never after a Claude Code builtin", () => {
    const [message] = convert([
      assistant([
        toolCall("a", "read"),
        toolCall("b", "bash"),
        toolCall("c", "my_custom_tool"),
      ]),
    ]);

    expect(message?.content).toStrictEqual([
      toolUse("a", `${MCP}read`),
      toolUse("b", `${MCP}bash`),
      toolUse("c", `${MCP}my_custom_tool`),
    ]);
  });

  it("joins text tool-result blocks with newlines", () => {
    expect(
      convert([toolResult("x", [text("line 1"), text("line 2")])])
    ).toStrictEqual([
      { role: "user", content: [resultBlock("x", "line 1\nline 2")] },
    ]);
  });

  // Claude Code stores screenshots as image blocks inside tool_result.content;
  // flattening to text would drop them from a rebuilt session.
  it("keeps image blocks in a tool result instead of flattening to text", () => {
    expect(
      convert([
        toolResult("x", [text("captured"), image("BASE64DATA", "image/png")]),
      ])
    ).toStrictEqual([
      {
        role: "user",
        content: [
          resultBlock("x", [
            { type: "text", text: "captured" },
            { type: "image", source: pngSource },
          ]),
        ],
      },
    ]);
  });

  // The string shape is what Claude Code writes for text-only results; switching to
  // blocks unconditionally would diverge from it and perturb the cache key.
  it("keeps a text-only tool result a flat string", () => {
    expect(convert([toolResult("x", [text("just text")])])).toStrictEqual([
      { role: "user", content: [resultBlock("x", "just text")] },
    ]);
  });

  it("marks tool-result blocks that are neither text nor image", () => {
    expect(
      convert([
        toolResult("x", [
          offTypeBlock("document"),
          image("BASE64DATA", "image/png"),
        ]),
      ])
    ).toStrictEqual([
      {
        role: "user",
        content: [
          resultBlock("x", [
            { type: "text", text: "[document]" },
            { type: "image", source: pngSource },
          ]),
        ],
      },
    ]);
  });

  it("keeps an image-only tool result", () => {
    expect(
      convert([toolResult("x", [image("BASE64DATA", "image/png")])])
    ).toStrictEqual([
      {
        role: "user",
        content: [resultBlock("x", [{ type: "image", source: pngSource }])],
      },
    ]);
  });
});

const parallelCall = (n: number): Message[] => {
  const ids = Array.from({ length: n }, (_, index) => `t${index}`);

  return [
    user("read them all"),
    assistant(ids.map((id) => toolCall(id, "read", { path: `${id}.txt` }))),
    ...ids.map((id) => toolResult(id, `body of ${id}`)),
  ];
};

// Every rebuild runs the conversion through repairToolPairing, once in the rebuild and
// once more inside Session.importMessages. It only pairs results in the user message
// directly after their assistant message, replacing anything later with a synthetic
// "[no tool result recorded]" error: that once destroyed the output of every parallel
// tool call in a rebuilt session.
describe("conversion survives repairToolPairing", () => {
  it("keeps every result of a parallel tool call", () => {
    const converted = convert(parallelCall(3));
    const repaired = repairToolPairing(converted);

    expect(repaired).toStrictEqual(converted);
    expect(
      toolResultBlocks(repaired).map((block) => block.content)
    ).toStrictEqual(["body of t0", "body of t1", "body of t2"]);
  });

  // Mid-turn steering puts a user message between the results, so adjacency alone does
  // not keep a parallel call together. Claude Code writes the same turn as
  // results-then-steer.
  it("collects results a steer interleaved, keeping the steer after them", () => {
    const repaired = repairToolPairing(
      convert([
        assistant([toolCall("t0", "read"), toolCall("t1", "read")]),
        toolResult("t0", "first"),
        user("actually, also check X"),
        toolResult("t1", "second"),
      ])
    );

    expect(repaired.map((message) => message.role)).toStrictEqual([
      "assistant",
      "user",
      "user",
    ]);
    expect(
      toolResultBlocks(repaired.slice(1, 2)).map((block) => block.content)
    ).toStrictEqual(["first", "second"]);
    expect(repaired[2]?.content).toBe("actually, also check X");
  });

  // A steer sent while the first tool is still running lands in pi's history before any
  // result. repairToolPairing hands the turn's stubs to the first user message after the
  // assistant, so the results have to be inserted ahead of it.
  it("collects results a steer preceded", () => {
    const repaired = repairToolPairing(
      convert([
        assistant([toolCall("t0", "read"), toolCall("t1", "read")]),
        user("actually stop and check X"),
        toolResult("t0", "first"),
        toolResult("t1", "second"),
      ])
    );

    expect(repaired.map((message) => message.role)).toStrictEqual([
      "assistant",
      "user",
      "user",
    ]);
    expect(
      toolResultBlocks(repaired.slice(1, 2)).map((block) => block.content)
    ).toStrictEqual(["first", "second"]);
    expect(repaired[2]?.content).toBe("actually stop and check X");
  });

  it("leaves no synthetic result stubs behind", () => {
    const stubs = toolResultBlocks(
      repairToolPairing(convert(parallelCall(5)))
    ).filter(
      (block) =>
        typeof block.content === "string" &&
        block.content.includes("no tool result recorded")
    );

    expect(stubs).toStrictEqual([]);
  });
});

describe("aborted assistant turns", () => {
  it("drops a turn aborted before anything streamed rather than fabricating one", () => {
    expect(
      convert([
        user([text("first ask")]),
        assistant([]),
        user([text("second ask")]),
      ])
    ).toStrictEqual([
      { role: "user", content: [{ type: "text", text: "first ask" }] },
      { role: "user", content: [{ type: "text", text: "second ask" }] },
    ]);
  });

  // The prompt cache is keyed on exact prefix bytes, so a rebuild must reproduce the
  // sequence Claude Code already cached. An aborted turn contributed nothing live, so a
  // placeholder for it would diverge at that index and cost every downstream cached token.
  it("preserves the cached prefix when rebuilding across an aborted turn", () => {
    const live = convert([
      user([text("first ask")]),
      user([text("second ask")]),
      assistant([text("answer")]),
    ]);

    const rebuilt = convert([
      user([text("first ask")]),
      assistant([]),
      user([text("second ask")]),
      assistant([text("answer")]),
    ]);

    expect(rebuilt).toStrictEqual(live);
  });

  it("lands a result stranded after an aborted turn on the real assistant", () => {
    expect(
      convert([
        assistant([toolCall("t1", "bash")]),
        assistant([]),
        toolResult("t1", "ok"),
      ])
    ).toStrictEqual([
      { role: "assistant", content: [toolUse("t1", `${MCP}bash`)] },
      { role: "user", content: [resultBlock("t1", "ok")] },
    ]);
  });
});

describe("dropped-content accounting", () => {
  it("counts stripped thinking by provider and aborted turns", () => {
    const { dropped } = convertPiMessages([
      assistant([thinking("reasoning"), text("the answer")], "openrouter"),
      assistant([]),
      assistant([thinking("mine", "sig")]),
    ]);

    expect(dropped.thinking).toBe(1);
    expect([...dropped.providers]).toStrictEqual(["openrouter"]);
    expect(dropped.abortedTurns).toBe(1);
    expect(dropped.other.size).toBe(0);
  });

  it("reports nothing when everything converts", () => {
    const { dropped } = convertPiMessages([
      user([text("hi")]),
      assistant([text("hello")]),
    ]);

    expect(dropped).toStrictEqual({
      thinking: 0,
      abortedTurns: 0,
      providers: new Set(),
      other: new Map(),
    });
  });
});

// Two invariants on the session write path (convertPiMessages → repairToolPairing →
// Session.importMessages):
//   1. Determinism. The same pi history always produces the same transcript content;
//      only identity and clock fields may differ between builds.
//   2. Prefix stability. A transcript built from a longer history is a strict
//      content-extension of the one built from a shorter history. Anthropic's prompt
//      cache is keyed on exact prompt-prefix bytes, so any mid-history mutation
//      re-caches everything after it on the next rebuild.

/** Record fields that legitimately differ between two builds of the same history:
 *  identity and clock, none of which reaches the Anthropic prompt. */
const VOLATILE = new Set([
  "uuid",
  "parentUuid",
  "sessionId",
  "timestamp",
  "slug",
  "requestId",
]);

const stableRecord = (record: JsonlRecord): string => {
  const entries: Array<[string, unknown]> = Object.entries(record);
  const kept = entries.filter(([key]) => !VOLATILE.has(key));

  return JSON.stringify(
    kept.map(([key, value]): [string, unknown] => [
      key,
      key === "message" && typeof value === "object" && value !== null
        ? Object.entries(value).filter(([field]) => field !== "id")
        : value,
    ])
  );
};

/** The whole write path reduced to the record content the prompt cache is keyed on. */
const transcript = (messages: readonly Message[]): string[] => {
  const repaired = repairToolPairing(
    convertPiMessages(messages).anthropicMessages
  );

  const session = createSession({ projectPath: process.cwd() });

  if (repaired.length > 0) {
    session.importMessages(repaired);
  }

  return session.records.map(stableRecord);
};

/** Prefix lengths at which every tool call issued so far has its result. Truncating
 *  mid-turn leaves repairToolPairing no choice but to stub the results that have not
 *  arrived, so only settled prefixes can be expected to extend cleanly. */
const settledPrefixes = (messages: readonly Message[]): number[] => {
  const lengths: number[] = [];
  const pending = new Set<string>();

  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") {
          pending.add(block.id);
        }
      }
    }

    if (message.role === "toolResult") {
      pending.delete(message.toolCallId);
    }

    if (pending.size === 0) {
      lengths.push(index + 1);
    }
  }

  return lengths;
};

const expectPrefix = (
  shorter: readonly string[],
  longer: readonly string[],
  label: string
): void => {
  expect(longer.slice(0, shorter.length), label).toStrictEqual(shorter);
};

const FixtureText = Type.Object({
  type: Type.Literal("text"),
  text: Type.String(),
});

const FixtureLine = Type.Union([
  Type.Object({ role: Type.Literal("user"), content: Type.Array(FixtureText) }),
  Type.Object({
    role: Type.Literal("assistant"),
    provider: Type.String(),
    content: Type.Array(
      Type.Union([
        FixtureText,
        Type.Object({
          type: Type.Literal("toolCall"),
          id: Type.String(),
          name: Type.String(),
          arguments: Type.Record(Type.String(), Type.Unknown()),
        }),
        Type.Object({
          type: Type.Literal("thinking"),
          thinking: Type.String(),
          thinkingSignature: Type.Optional(Type.String()),
        }),
      ])
    ),
  }),
  Type.Object({
    role: Type.Literal("toolResult"),
    toolCallId: Type.String(),
    content: Type.Array(FixtureText),
    isError: Type.Boolean(),
  }),
]);

const decodeFixtureLine = (line: string): Message => {
  const raw: unknown = JSON.parse(line);
  const decoded = Value.Parse(FixtureLine, raw);

  if (decoded.role === "user") {
    return user(decoded.content.map((block) => text(block.text)));
  }

  if (decoded.role === "toolResult") {
    return toolResult(
      decoded.toolCallId,
      decoded.content.map((block) => text(block.text)),
      decoded.isError
    );
  }

  return assistant(
    decoded.content.map((block) => {
      if (block.type === "text") {
        return text(block.text);
      }

      if (block.type === "thinking") {
        return thinking(block.thinking, block.thinkingSignature);
      }

      const args = toJsonObject(block.arguments);

      if (args === undefined) {
        throw new Error(`fixture tool call ${block.id} has no JSON arguments`);
      }

      return toolCall(block.id, block.name, args);
    }),
    decoded.provider
  );
};

// A real 310-message pi session with its content scrubbed: text bodies became
// `t<n>:<length>` placeholders and tool arguments `a<n>:<length>` ones. Structure
// (roles, block types, tool ids, providers, thinking signatures, parallel calls) is
// verbatim, and structure is all these invariants read.
const corpus = readFileSync(
  new URL("../fixtures/pi-history-310.jsonl", import.meta.url),
  "utf-8"
)
  .split("\n")
  .filter((line) => line !== "")
  .map(decodeFixtureLine);

// Parallel calls, a steer landing between their results, an image result, an error
// result, empty content, exotic tool ids, thinking with and without a signature, and
// thinking from providers whose signatures may not be replayed.
const exotic: Message[] = [
  user("start"),
  assistant([
    thinking("planning", "sigA"),
    text("reading two files"),
    toolCall("functions.read:0", "read", { path: "a" }),
    toolCall("functions.read:1", "read", { path: "b" }),
  ]),
  toolResult("functions.read:0", "body a"),
  user("actually also check c"),
  toolResult("functions.read:1", [text("shot"), image("BASE64", "image/png")]),
  assistant(
    [thinking("foreign", "sigB"), toolCall("tool call#2@x", "my_custom_tool")],
    "openrouter"
  ),
  toolResult("tool call#2@x", [], true),
  assistant([thinking("unsigned")]),
  user(""),
  user([image("IMG", "image/jpeg")]),
  assistant([toolCall("t9", "bash", { cmd: "ls" })]),
  toolResult("t9", [offTypeBlock("document")]),
  assistant([text("done")]),
];

describe("conversion is deterministic", () => {
  it("converts a real 310-message session identically twice", () => {
    expect(corpus).toHaveLength(310);
    expect(transcript(corpus)).toStrictEqual(transcript(corpus));
  });

  it("converts parallel calls, images, errors and thinking blocks identically twice", () => {
    expect(transcript(exotic)).toStrictEqual(transcript(exotic));
  });
});

describe("rebuilds extend the transcript instead of rewriting it", () => {
  // Comparing every settled prefix against the full transcript also settles the pairwise
  // claim: two prefixes of the same sequence are prefixes of each other.
  it("keeps every settled prefix of a real session a prefix of the full rebuild", () => {
    const full = transcript(corpus);
    const lengths = settledPrefixes(corpus);

    expect(lengths.length).toBeGreaterThan(100);

    for (const n of lengths) {
      expectPrefix(transcript(corpus.slice(0, n)), full, `history[0..${n}]`);
    }
  });

  it("keeps a settled prefix through every longer history, mid-turn truncation included", () => {
    for (const n of settledPrefixes(exotic)) {
      const shorter = transcript(exotic.slice(0, n));

      for (let m = n + 1; m <= exotic.length; m += 1) {
        expectPrefix(
          shorter,
          transcript(exotic.slice(0, m)),
          `exotic[0..${n}] vs [0..${m}]`
        );
      }
    }
  });
});

describe("convertPiMessages", () => {
  // The rebuild repairs before calling importMessages, which repairs again, so a second
  // pass has to be a no-op or every rebuild would differ from the transcript the debug
  // log reports.
  it("repairToolPairing is idempotent over a converted session", () => {
    const once = repairToolPairing(convertPiMessages(corpus).anthropicMessages);

    expect(repairToolPairing(once)).toStrictEqual(once);
  });

  // Prefix stability is satisfiable by a conversion that loses content consistently, so
  // pin the content too: a conversion that dropped every parallel result past the first
  // passed both invariants above.
  it("round-trips a real session with every tool result intact", () => {
    const blocks = toolResultBlocks(
      repairToolPairing(convertPiMessages(corpus).anthropicMessages)
    );

    const expected = corpus.flatMap((message) =>
      message.role === "toolResult" ? [message.toolCallId] : []
    );

    expect(blocks.map((block) => block.tool_use_id)).toStrictEqual(expected);
    expect(
      blocks.filter(
        (block) =>
          typeof block.content === "string" &&
          block.content.includes("no tool result recorded")
      )
    ).toStrictEqual([]);
  });
});
