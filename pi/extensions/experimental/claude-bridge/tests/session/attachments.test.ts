import type { JsonlRecord } from "cc-session-io";
import { describe, expect, it } from "vite-plus/test";

import { collectCarriedAttachments, placeCarriedAttachments } from "../../session/attachments.js";
import type { CarriedAttachment } from "../../session/attachments.js";

const prompt = (uuid: string, text: string): JsonlRecord => ({
  type: "user",
  uuid,
  message: { role: "user", content: [{ type: "text", text }] },
});

const toolResultRecord = (uuid: string): JsonlRecord => ({
  type: "user",
  uuid,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
});

const attach = (
  uuid: string,
  parentUuid: string,
  type: string,
  filename?: string,
): JsonlRecord => ({
  type: "attachment",
  uuid,
  parentUuid,
  attachment: { type, ...(filename === undefined ? {} : { filename }) },
});

const filenames = (carried: readonly CarriedAttachment[]): unknown[] =>
  carried.map((item) => item.attachment.filename);

describe("collectCarriedAttachments", () => {
  it("keeps content-bearing kinds and drops the ones Claude Code regenerates", () => {
    const carried = collectCarriedAttachments([
      prompt("u1", "review @a.js"),
      attach("a1", "u1", "file", "/a.js"),
      attach("a2", "u1", "skill_listing"),
      attach("a3", "u1", "task_reminder"),
      attach("a4", "u1", "edited_text_file", "/b.js"),
    ]);

    // edited_text_file is deliberately not carried: the edit is already in pi's history
    // as a tool call, and it usually hangs off a tool-result record with no prompt ordinal.
    expect(carried).toEqual([
      {
        attachment: { type: "file", filename: "/a.js" },
        userOrdinal: 0,
        parentText: "review @a.js",
      },
    ]);
  });

  it("counts ordinals over prompts only, skipping tool-result user records", () => {
    const carried = collectCarriedAttachments([
      prompt("u1", "first"),
      toolResultRecord("u2"),
      prompt("u3", "review @a.js"),
      attach("a1", "u3", "file", "/a.js"),
    ]);

    expect(carried).toEqual([
      {
        attachment: { type: "file", filename: "/a.js" },
        userOrdinal: 1,
        parentText: "review @a.js",
      },
    ]);
  });

  it("ignores an attachment whose parent is not a prompt", () => {
    expect(
      collectCarriedAttachments([
        prompt("u1", "first"),
        attach("a1", "missing-uuid", "file", "/a.js"),
      ]),
    ).toEqual([]);
  });
});

describe("placeCarriedAttachments", () => {
  const carried: CarriedAttachment[] = [
    {
      attachment: { type: "file", filename: "/a.js" },
      userOrdinal: 1,
      parentText: "review @a.js",
    },
  ];

  it("resolves the ordinal to an index in the array being imported", () => {
    expect(
      placeCarriedAttachments(carried, [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "review @a.js" }] },
      ]),
    ).toEqual({
      attachments: [{ afterIndex: 2, attachment: { type: "file", filename: "/a.js" } }],
      skipped: [],
    });
  });

  it("skips tool-result user messages when counting prompts", () => {
    expect(
      placeCarriedAttachments(carried, [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        { role: "user", content: "review @a.js" },
      ]).attachments,
    ).toEqual([{ afterIndex: 3, attachment: { type: "file", filename: "/a.js" } }]);
  });

  it("drops it when that prompt changed rather than guessing", () => {
    const { attachments, skipped } = placeCarriedAttachments(carried, [
      { role: "user", content: "first" },
      { role: "user", content: "something else entirely" },
    ]);

    expect(attachments).toEqual([]);
    expect(skipped).toEqual([expect.stringMatching(/^\/a\.js: .*changed/)]);
  });

  it("drops it when history no longer reaches that prompt", () => {
    const { attachments, skipped } = placeCarriedAttachments(carried, [
      { role: "user", content: "first" },
    ]);

    expect(attachments).toEqual([]);
    expect(skipped).toEqual([expect.stringMatching(/^\/a\.js: .*no longer in history/)]);
  });
});

describe("attachments chained to other attachments", () => {
  it("inherits the ordinal up a run so the whole run keys to one prompt", () => {
    const carried = collectCarriedAttachments([
      prompt("u1", "first"),
      prompt("u2", "edit the files"),
      attach("a1", "u2", "file", "/a.js"),
      attach("a2", "a1", "edited_text_file", "/b.js"),
      attach("a3", "a2", "file", "/c.js"),
    ]);

    // The uncarried kind still has to resolve, or the run breaks after it.
    expect(filenames(carried)).toEqual(["/a.js", "/c.js"]);
    expect(carried.map((item) => item.userOrdinal)).toEqual([1, 1]);
    expect(carried.map((item) => item.parentText)).toEqual(["edit the files", "edit the files"]);
  });

  it("resolves through a kind it does not carry", () => {
    const carried = collectCarriedAttachments([
      prompt("u1", "go"),
      attach("a1", "u1", "skill_listing"),
      attach("a2", "a1", "file", "/a.js"),
    ]);

    expect(filenames(carried)).toEqual(["/a.js"]);
    expect(carried.map((item) => item.userOrdinal)).toEqual([0]);
  });
});
