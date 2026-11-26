import { stripVTControlCharacters } from "node:util";

import { initTheme } from "@earendil-works/pi-coding-agent";
import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { createIdentityTheme } from "../../../../tests/harness/tui.js";
import { ENDED, OPENED } from "../journal.js";
import type { Ended, Opened } from "../journal.js";
import { clock, endedCard, openedCard, span, wakeMessage } from "../render.js";
import type { WakeDetails } from "../report.js";
import { WAKE_TYPE } from "../runtime.js";

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
  (component?.render(80) ?? []).map((row) =>
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

const noon = new Date(2026, 10, 21, 12, 0).getTime();

const opened: Opened = {
  id: "w_1a2b3c4d",
  owner: "s1",
  spec: {
    label: "job result",
    condition: "test -f result.json",
    instruction: "Consume the result once.",
    cwd: "/work",
    intervalSeconds: 15,
    checkTimeoutSeconds: 30,
  },
  expiresAt: noon + 3_600_000,
};

const wake = (waits: WakeDetails["waits"]) => ({
  role: "custom" as const,
  customType: WAKE_TYPE,
  content: "model text",
  display: true,
  details: { waits } satisfies WakeDetails,
  timestamp: 0,
});

const ended = (outcome: Ended["outcome"]) =>
  endedCard(
    (id) => (id === "w_1a2b3c4d" ? "job result" : undefined),
    () => 1
  )(entry(ENDED, { id: "w_1a2b3c4d", outcome } satisfies Ended), view, theme);

describe("wait cards", () => {
  beforeAll(() => {
    initTheme("dark");
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(noon);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws an opened wait with its condition, cadence and id, and the instruction only when expanded", () => {
    const collapsed = rows(
      openedCard(() => 1)(entry(OPENED, opened), view, theme)
    );

    const expanded = rows(
      openedCard(() => 1)(
        entry(OPENED, opened),
        { ...view, expanded: true },
        theme
      )
    );

    expect(collapsed[0]).toMatch(/^ ⏳ waiting on job result +w_1a2b3c4d$/u);
    expect(collapsed[1]).toBe("   test -f result.json");
    expect(collapsed[2]).toBe("   every 15s · expires 13:00");
    expect(collapsed.join("\n")).not.toContain("Consume");
    expect(expanded.join("\n")).toContain("Consume the result once.");
  });

  it("draws a cancellation with the wait's label, and nothing for an outcome the wake will carry", () => {
    expect(rows(ended("cancelled"))[0]).toMatch(
      /^ ■ wait cancelled job result +w_1a2b3c4d$/u
    );
    expect(ended("satisfied")).toBeUndefined();
    expect(ended("expired")).toBeUndefined();
  });

  it("ignores entries that are not well-formed", () => {
    expect(
      openedCard(() => 1)(entry(OPENED, { id: 1 }), view, theme)
    ).toBeUndefined();
  });

  it("draws one card per woken wait with its outcome and instruction", () => {
    const drawn = rows(
      wakeMessage(
        wake([
          {
            id: "w_1",
            label: "job result",
            outcome: "satisfied",
            lastCheck: "last check exited 0",
            instruction: "Consume the result once.",
          },
          {
            id: "w_2",
            label: "deploy",
            outcome: "expired",
            lastCheck: "last check exited 1",
            instruction: "Ship it.",
          },
        ]),
        view,
        theme
      )
    ).join("\n");

    expect(drawn).toMatch(/✓ wait satisfied job result +w_1/u);
    expect(drawn).toContain("condition exited 0 · woke the agent");
    expect(drawn).toContain("Consume the result once.");
    expect(drawn).toMatch(/✗ wait expired deploy +w_2/u);
    expect(drawn).toContain("never exited 0 · last check exited 1");
  });

  it("leaves a wake without details to Pi's default rendering", () => {
    expect(
      wakeMessage({ ...wake([]), details: undefined }, view, theme)
    ).toBeUndefined();
  });
});

describe("time", () => {
  it("shows a duration as its two largest units", () => {
    expect(
      [9000, 59_400, 3_420_000, 10_920_000, 7_200_000, 187_200_000].map(span)
    ).toStrictEqual(["9s", "59s", "57m", "3h 2m", "2h", "2d 4h"]);
  });

  it("adds the date only when the time is not today", () => {
    const now = new Date(2026, 10, 21, 12, 0).getTime();

    expect(clock(new Date(2026, 10, 21, 20, 42).getTime(), now)).toMatch(
      /^20:42$/u
    );
    expect(clock(new Date(2026, 10, 22, 9, 5).getTime(), now)).toMatch(
      /22.*09:05$/u
    );
  });
});
