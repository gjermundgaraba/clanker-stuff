import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import {
  createCapture,
  evalConfig,
  rpcMessage,
  startedThreadId,
  startedTurnId,
} from "../runtime/codex-eval.mjs";

const requiredConfig = { instructionPath: "/tmp/instruction", model: "test-model" };

const defaultConfig = {
  compactBefore: false,
  compactedAfterSegment: -1,
  effort: null,
  ...requiredConfig,
  summary: null,
};

const invalidObjects = [null, false, 1, "value", []];

const invalidStrings = [null, false, 1, "", [], {}];

void describe("Codex config validation", () => {
  void it("defaults only absent options and drops unrecognized config keys without mutating input", () => {
    const input = Object.freeze({ ...requiredConfig, extra: true });
    assert.deepStrictEqual(evalConfig(input), defaultConfig);
    assert.deepStrictEqual(input, { ...requiredConfig, extra: true });
    assert.deepStrictEqual(evalConfig({ ...requiredConfig, effort: "", summary: "" }), {
      ...defaultConfig,
      effort: "",
      summary: "",
    });
    assert.deepStrictEqual(
      evalConfig({
        ...requiredConfig,
        compactBefore: true,
        compactedAfterSegment: 0,
        effort: "high",
        summary: "detailed",
      }),
      {
        ...defaultConfig,
        compactBefore: true,
        compactedAfterSegment: 0,
        effort: "high",
        summary: "detailed",
      },
    );
  });

  const malformed = [
    ...invalidObjects,
    {},
    ...["instructionPath", "model"].flatMap((key) =>
      [...invalidStrings, undefined].map((value) => ({ ...requiredConfig, [key]: value })),
    ),
    ...[null, undefined, 0, 1, "false", [], {}].map((compactBefore) => ({
      ...requiredConfig,
      compactBefore,
    })),
    ...[null, undefined, -2, 1.5, "0", false, [], {}, Infinity].map((compactedAfterSegment) => ({
      ...requiredConfig,
      compactedAfterSegment,
    })),
    ...["effort", "summary"].flatMap((key) =>
      [undefined, false, 1, [], {}].map((value) => ({ ...requiredConfig, [key]: value })),
    ),
  ];

  for (const value of malformed) {
    void it(`rejects ${inspect(value)} without coercion`, () => {
      assert.throws(() => evalConfig(value), TypeError);
    });
  }
});

void describe("Codex JSON-RPC validation", () => {
  void it("keeps missing, null and falsy result/error payloads distinct", () => {
    assert.deepStrictEqual(rpcMessage({}), {
      hasError: false,
      hasResult: false,
    });

    for (const key of /** @type {const} */ (["error", "result"])) {
      for (const value of [null, false, 0, "", {}, [], undefined]) {
        const message = rpcMessage({ id: 1, [key]: value });
        assert.strictEqual(message.hasError, key === "error");
        assert.strictEqual(message.hasResult, key === "result");
        assert.strictEqual(message[key], value);
      }
    }

    assert.partialDeepStrictEqual(rpcMessage({ id: "", result: null, error: null }), {
      hasError: true,
      hasResult: true,
      id: "",
    });
  });

  void it("preserves extra service params/item/turn fields without mutating input", () => {
    const item = Object.freeze({ text: "answer" });
    const turn = Object.freeze({ id: "turn", status: "future-status", items: [item] });
    const args = Object.freeze({ query: "needle" });
    const usage = Object.freeze({ futureCounter: 42 });

    const params = Object.freeze({
      arguments: args,
      callId: "call",
      item,
      namespace: null,
      tool: "ledger_query",
      turn,
      usage,
    });

    const input = Object.freeze({ method: "item/tool/call", params, extra: "ignored" });
    const message = rpcMessage(input);
    assert.equal("extra" in message, false);
    assert.deepStrictEqual(message.params, params);
    assert.deepStrictEqual(item, { text: "answer" });
    assert.deepStrictEqual(rpcMessage({ params: {} }).params, {});
  });

  void it("accepts integer and string IDs", () => {
    for (const id of [0, -1, Number.MAX_SAFE_INTEGER + 1, "", "request", undefined]) {
      assert.strictEqual(rpcMessage({ id }).id, id);
    }
  });

  const malformed = [
    ...invalidObjects,
    ...[null, true, [], {}, NaN, 1.5].map((id) => ({ id })),
    ...["1e400", "-1e400"].map(
      /** @returns {unknown} */ (literal) => JSON.parse(`{"id":${literal}}`),
    ),
    ...invalidStrings.map((method) => ({ method })),
    ...invalidObjects.map((params) => ({ params })),
    ...["responseId", "threadId", "turnId"].flatMap((key) =>
      invalidStrings.map((value) => ({ params: { [key]: value } })),
    ),
    ...["item", "turn"].flatMap((key) =>
      invalidObjects.map((value) => ({ params: { [key]: value } })),
    ),
    ...["id", "type"].flatMap((key) =>
      invalidStrings.map((value) => ({ params: { item: { [key]: value } } })),
    ),
    { params: { turn: {} } },
    ...["id", "status"].flatMap((key) =>
      [...invalidStrings, undefined].map((value) => ({
        params: { turn: { id: "turn", status: "completed", [key]: value } },
      })),
    ),
  ];

  for (const value of malformed) {
    void it(`rejects ${inspect(value)} without coercion`, () => {
      assert.throws(() => rpcMessage(value), TypeError);
    });
  }
});

for (const { key, parse } of [
  { key: "thread", parse: startedThreadId },
  { key: "turn", parse: startedTurnId },
]) {
  void describe(`Codex ${key}/start result validation`, () => {
    void it("requires only a non-empty ID and preserves whitespace", () => {
      assert.strictEqual(parse({ [key]: { id: " ", extra: true }, extra: true }), " ");
    });

    const malformed = [
      ...invalidObjects,
      {},
      ...invalidObjects.map((value) => ({ [key]: value })),
      ...[...invalidStrings, undefined].map((id) => ({ [key]: { id } })),
    ];

    for (const value of malformed) {
      void it(`rejects ${inspect(value)}`, () => {
        assert.throws(() => parse(value), TypeError);
      });
    }
  });
}

void describe("Codex usage and compaction capture", () => {
  void it("classifies responses and settles compactions in either hook order", () => {
    const capture = createCapture();

    /**
     * @param {string} method
     * @param {import("../runtime/codex-eval.mjs").RpcParams} params
     */
    const accept = (method, params) =>
      capture.accept({ hasError: false, hasResult: false, method, params });

    accept("rawResponse/completed", {
      responseId: "a",
      threadId: "t",
      turnId: "ordinary",
      usage: {},
    });
    capture.beginCompaction("succeeded");
    accept("item/started", { item: { id: "c1", type: "contextCompaction" }, turnId: "succeeded" });
    accept("rawResponse/completed", {
      responseId: "b",
      threadId: "t",
      turnId: "succeeded",
      usage: {},
    });
    accept("item/completed", {
      item: { id: "c1", type: "contextCompaction" },
      turnId: "succeeded",
    });
    accept("rawResponse/completed", {
      responseId: "c",
      threadId: "t",
      turnId: "succeeded",
      usage: {},
    });
    accept("turn/completed", { turn: { id: "succeeded", status: "completed" } });
    capture.beginCompaction("failed");
    accept("item/started", { item: { id: "c2", type: "contextCompaction" }, turnId: "failed" });
    accept("rawResponse/completed", {
      responseId: "d",
      threadId: "t",
      turnId: "failed",
      usage: null,
    });
    accept("turn/completed", { turn: { id: "failed", status: "failed" } });
    capture.beginCompaction("aborted");
    accept("item/started", { item: { id: "c3", type: "contextCompaction" }, turnId: "aborted" });
    accept("turn/completed", { turn: { id: "aborted", status: "interrupted" } });
    // The terminal turn may arrive before the runner registers the compaction.
    accept("turn/completed", { turn: { id: "pre-hook", status: "interrupted" } });
    capture.beginCompaction("pre-hook");
    capture.beginCompaction("post-hook");
    accept("item/started", { item: { id: "c4", type: "contextCompaction" }, turnId: "post-hook" });
    accept("rawResponse/completed", {
      responseId: "e",
      threadId: "t",
      turnId: "post-hook",
      usage: {},
    });
    accept("item/completed", {
      item: { id: "c4", type: "contextCompaction" },
      turnId: "post-hook",
    });
    accept("turn/completed", { turn: { id: "post-hook", status: "interrupted" } });

    const captured = capture.finish();
    assert.deepStrictEqual(
      captured.records.map(({ kind }) => kind),
      ["ordinary", "compaction", "ordinary", "compaction"],
    );
    assert.deepStrictEqual(
      captured.attempts.map(({ state }) => state),
      ["succeeded", "failed", "aborted", "aborted", "succeeded"],
    );
  });

  void it("rejects a completed compaction turn without an item completion", () => {
    const capture = createCapture();
    capture.beginCompaction("malformed");
    assert.throws(
      () =>
        capture.accept({
          hasError: false,
          hasResult: false,
          method: "turn/completed",
          params: { turn: { id: "malformed", status: "completed" } },
        }),
      /omitted item\/completed/,
    );
  });
});

void it("runs the CLI through a symlink beside dependencies without losing entrypoint detection", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-eval-test-"));
  const executable = path.join(directory, "codex-eval");

  try {
    symlinkSync(path.resolve(import.meta.dirname, "../runtime/codex-eval.mjs"), executable);
    execFileSync(process.execPath, [executable, "--self-test"]);
    const result = spawnSync(process.execPath, [executable], { encoding: "utf8" });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /usage: codex-eval CONFIG_JSON/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
