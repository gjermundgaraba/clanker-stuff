import { stripVTControlCharacters } from "node:util";

import { initTheme } from "@earendil-works/pi-coding-agent";
import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { createIdentityTheme } from "../../../../tests/harness/tui.js";
import { SENT, UNDELIVERED, MESSAGE_TYPE } from "../entries.js";
import type { Undelivered } from "../entries.js";
import type { Letter } from "../mailbox.js";
import { receivedMessage, sentCard, undeliveredCard } from "../render.js";
import { shortPath } from "../report.js";

const theme = createIdentityTheme();

const view = {
  expanded: false,
  outputPad: 1,
  keyHint: (_id: string, text: string) => text,
  keyText: () => "",
};

const rows = (
  component: { render: (width: number) => readonly string[] } | undefined
) =>
  (component?.render(60) ?? []).map((row) =>
    stripVTControlCharacters(row).trimEnd()
  );

const entry = (customType: string, data: unknown): CustomEntry => ({
  type: "custom",
  customType,
  data,
  id: "e1",
  parentId: null,
  timestamp: new Date(0).toISOString(),
});

const letter: Letter = {
  id: "m_a5b85837",
  from: "b",
  to: "a",
  text: "kestrel-raven-8894",
  sentAt: 0,
};

describe("peer cards", () => {
  beforeAll(() => {
    initTheme("dark");
  });

  it("shows a received message as its sender and text, without the reply instruction meant for the model", () => {
    const drawn = rows(
      receivedMessage(
        {
          role: "custom",
          customType: MESSAGE_TYPE,
          content: "Message from … To answer, call peer_send",
          display: true,
          details: letter,
          timestamp: 0,
        },
        view,
        theme
      )
    );

    expect(drawn[0]).toMatch(/^ ✉ message from b +m_a5b85837$/u);
    expect(drawn[1]).toBe("   kestrel-raven-8894");
    expect(drawn.join("\n")).not.toContain("peer_send");
  });

  it("shows a sent message as its recipient and text", () => {
    const drawn = rows(
      sentCard(() => 1)(
        entry(SENT, { ...letter, from: "a", to: "b" }),
        view,
        theme
      )
    );

    expect(drawn[0]).toMatch(/^ ↗ message to b +m_a5b85837$/u);
    expect(drawn[1]).toBe("   kestrel-raven-8894");
  });

  it("shows why a send reached no one, and who could have been reached", () => {
    const failed: Undelivered = {
      to: "ghost",
      text: "hello?",
      reason: "no live session has that name",
      live: ["b"],
    };

    expect(
      rows(undeliveredCard(() => 1)(entry(UNDELIVERED, failed), view, theme))
    ).toStrictEqual([
      " ✗ not delivered to ghost",
      "   no live session has that name · live: b",
      "   hello?",
    ]);
  });

  it("leaves malformed data to Pi's defaults", () => {
    expect(
      sentCard(() => 1)(entry(SENT, { to: "b" }), view, theme)
    ).toBeUndefined();
  });

  it("shortens paths under the home directory", () => {
    expect(
      ["/home/me", "/home/me/code", "/home/meta", "/tmp"].map((path) =>
        shortPath(path, "/home/me")
      )
    ).toStrictEqual(["~", "~/code", "/home/meta", "/tmp"]);
  });
});
