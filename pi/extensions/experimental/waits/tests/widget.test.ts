import { stripVTControlCharacters } from "node:util";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { createActor, createAsyncLogic } from "xstate";

import {
  createIdentityTheme,
  createMockTui,
} from "../../../../tests/harness/tui.js";
import { waitMachine } from "../machine.js";
import type { WaitSpec } from "../spec.js";
import { LiveWaitsWidget } from "../widget.js";
import type { LiveWait } from "../widget.js";

const spec: WaitSpec = {
  label: "job result",
  condition: "false",
  instruction: "Use it.",
  cwd: "/",
  intervalSeconds: 15,
  checkTimeoutSeconds: 1,
};

const failingWait = (id: string) => {
  const check = createAsyncLogic({ run: async () => await Promise.resolve(1) });

  return createActor(waitMachine.provide({ actors: { check } }), {
    input: { id, spec, remainingMs: 3_600_000 },
  });
};

const plain = (rows: readonly string[]) =>
  rows.map((row) => stripVTControlCharacters(row));

describe("the live waits widget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts down to the next check and the deadline, redrawing every second until disposed", async () => {
    const actor = failingWait("w_1");
    actor.start();
    await vi.advanceTimersByTimeAsync(0);

    const expiresAt = Date.now() + 3_600_000;
    const tui = createMockTui();
    const requestRender = vi.spyOn(tui, "requestRender");

    const widget = new LiveWaitsWidget(tui, createIdentityTheme(), () => [
      { snapshot: actor.getSnapshot(), expiresAt },
    ]);

    await vi.advanceTimersByTimeAsync(6000);

    expect(plain(widget.render(100))).toStrictEqual([
      expect.stringMatching(
        /^ ● job result last check exited 1 · next in 9s · 59m left +w_1 $/u
      ),
    ]);
    expect(requestRender).toHaveBeenCalledTimes(6);

    widget.dispose();
    await vi.advanceTimersByTimeAsync(3000);

    expect(requestRender).toHaveBeenCalledTimes(6);
    actor.stop();
  });

  it("shows the first five live waits and how many more there are", async () => {
    const actors = Array.from({ length: 7 }, (_, index) =>
      failingWait(`w_${index}`)
    );

    for (const actor of actors) {
      actor.start();
    }

    await vi.advanceTimersByTimeAsync(0);

    const live: LiveWait[] = actors.map((actor) => ({
      snapshot: actor.getSnapshot(),
      expiresAt: Date.now() + 60_000,
    }));

    const widget = new LiveWaitsWidget(
      createMockTui(),
      createIdentityTheme(),
      () => live
    );

    const rows = plain(widget.render(100));

    expect(rows).toHaveLength(6);
    expect(rows.at(-1)).toBe("   … 2 more · /waits");
    widget.dispose();

    for (const actor of actors) {
      actor.stop();
    }
  });
});
