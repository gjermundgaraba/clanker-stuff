import { rm } from "node:fs/promises";

import type { Message } from "@earendil-works/pi-ai";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createTempDir } from "../../../../../tests/helpers/fs.js";
import {
  historyDigest,
  latestRecord,
  SESSION_ENTRY,
} from "../../session/warm.js";
import type { SessionRecord } from "../../session/warm.js";
import {
  assistant,
  image,
  text,
  thinking,
  toolCall,
  toolResult,
  user,
} from "./messages.js";

const record = (session: string): SessionRecord => ({
  session,
  cwd: "/project",
  held: 2,
  digest: "digest",
  bytes: 10,
});

const custom = (customType: string, data: unknown) => ({
  type: "custom",
  customType,
  data,
});

describe(latestRecord, () => {
  it("takes the branch's newest record that checks", () => {
    expect(
      latestRecord([
        custom(SESSION_ENTRY, record("cc-old")),
        { type: "message" },
        custom(SESSION_ENTRY, record("cc-new")),
        custom(SESSION_ENTRY, { ...record("cc-broken"), held: "two" }),
        custom("another-extension", record("cc-foreign")),
      ])
    ).toStrictEqual(record("cc-new"));
  });

  it("finds none on a branch without one", () => {
    expect(latestRecord([{ type: "message" }])).toBeUndefined();
  });
});

describe("the history digest", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("is the same for the history pi reads back from its session file", async () => {
    dir = await createTempDir("claude-bridge-warm-");

    const history: Message[] = [
      user([text("look at this"), image("aGk=", "image/png")]),
      assistant([
        thinking("Reading it.", "signature"),
        text("Let me check."),
        toolCall("toolu_1", "read", { path: "a.txt", limit: 10 }),
      ]),
      toolResult("toolu_1", "contents"),
      assistant([text("Done.")]),
    ];

    const written = SessionManager.create(dir, dir);

    for (const message of history) {
      written.appendMessage(message);
    }

    const file = written.getSessionFile();

    if (file === undefined) {
      throw new Error("pi did not write the session file");
    }

    const reread = convertToLlm(
      SessionManager.open(file, dir).buildSessionContext().messages
    );

    expect(reread).toHaveLength(history.length);
    expect(historyDigest(reread)).toBe(historyDigest(history));
  });
});
