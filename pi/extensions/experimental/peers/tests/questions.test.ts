import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { MESSAGE_TYPE, SENT } from "../entries.js";
import type { Letter } from "../mailbox.js";
import { openQuestions } from "../questions.js";

const letter = (id: string, patch: Partial<Letter> = {}): Letter => ({
  id,
  from: "a",
  to: "b",
  text: "?",
  sentAt: 1,
  ...patch,
});

const sent = (data: Letter): SessionEntry => ({
  type: "custom",
  customType: SENT,
  data,
  id: `e_${data.id}`,
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
});

const arrived = (details: Letter): SessionEntry => ({
  type: "custom_message",
  customType: MESSAGE_TYPE,
  content: "",
  display: true,
  details,
  id: `r_${details.id}`,
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
});

describe("open questions", () => {
  it("are the questions sent with no answer delivered since", () => {
    const entries = [
      sent(letter("m_1")),
      sent(letter("m_2")),
      sent(letter("m_3", { replyTo: "m_x" })),
      arrived(letter("m_9", { from: "b", to: "a", replyTo: "m_1" })),
      arrived(letter("m_8", { from: "b", to: "a" })),
    ];

    expect([...openQuestions(entries).keys()]).toStrictEqual(["m_2"]);
  });
});
