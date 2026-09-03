import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LayoutMetrics, OverlayLayout } from "../layout.js";
import { createOverlayController } from "../overlay.js";

const FRAME_INTERVAL_MS = 1000 / 60;

class FakeStream {
  columns = 80;
  rows = 24;
  writes: string[] = [];
  acceptWrites = true;
  private drainListeners: (() => void)[] = [];

  write = (chunk: string): boolean => {
    this.writes.push(chunk);
    return this.acceptWrites;
  };

  once(event: "drain", listener: () => void): void {
    if (event !== "drain") {
      return;
    }
    this.drainListeners.push(listener);
  }

  removeListener(event: "drain", listener: () => void): void {
    if (event !== "drain") {
      return;
    }
    this.drainListeners = this.drainListeners.filter(
      (candidate) => candidate !== listener
    );
  }

  emitDrain(): void {
    const listeners = this.drainListeners;
    this.drainListeners = [];
    for (const listener of listeners) {
      listener();
    }
  }
}

const makeLayout = (pixelWidth = 720): OverlayLayout => ({
  columns: 80,
  phaseX: 0,
  phaseY: 0,
  pixelHeight: 432,
  pixelWidth,
  rows: 24,
});

const makeMetrics = (): LayoutMetrics => ({
  cellHeightPx: 18,
  cellWidthPx: 9,
  columns: 80,
  rows: 24,
});

const setup = (options?: {
  layout?: () => OverlayLayout;
  metrics?: () => LayoutMetrics;
}) => {
  const clock = { now: 0 };
  const stream = new FakeStream();
  const controller = createOverlayController({
    fps: 60,
    layout: options?.layout ?? (() => makeLayout()),
    metrics: options?.metrics ?? makeMetrics,
    now: () => clock.now,
    out: stream as unknown as NodeJS.WriteStream,
  });
  const advance = (ms: number) => {
    clock.now += ms;
    vi.advanceTimersByTime(ms);
  };
  return { advance, clock, controller, stream };
};

describe(createOverlayController, () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("places the control image once and then alternates heartbeats", () => {
    const { advance, controller, stream } = setup();
    controller.start("manual");

    expect(stream.writes[0]).toContain("o=z,");
    const heartbeats = () =>
      stream.writes.filter((write) => write.includes(",s=1,v=1,"));
    const controls = () =>
      stream.writes.filter((write) => write.includes("o=z,"));

    advance(FRAME_INTERVAL_MS + 1);
    expect(heartbeats()).toHaveLength(1);
    advance(FRAME_INTERVAL_MS + 1);
    expect(heartbeats()).toHaveLength(2);
    expect(controls()).toHaveLength(1);
    expect(controller.status()).toMatchObject({ frames: 2, running: true });
  });

  it("writes alternating heartbeat payloads", () => {
    const { advance, controller, stream } = setup();
    controller.start("auto");
    advance(FRAME_INTERVAL_MS + 1);
    advance(FRAME_INTERVAL_MS + 1);
    const heartbeats = stream.writes.filter((write) =>
      write.includes(",s=1,v=1,")
    );
    expect(heartbeats).toHaveLength(2);
    expect(heartbeats[0]).not.toBe(heartbeats[1]);
  });

  it("stops the frame loop and deletes both images", () => {
    const { advance, controller, stream } = setup();
    controller.start("manual");
    advance(FRAME_INTERVAL_MS + 1);
    controller.stop();

    const last = stream.writes.at(-1) ?? "";
    expect(last.match(/a=d,d=I/gu)).toHaveLength(2);
    expect(last).toContain("\u001B[?25h");

    const count = stream.writes.length;
    advance(FRAME_INTERVAL_MS * 5);
    expect(stream.writes).toHaveLength(count);
    expect(controller.status().running).toBeFalsy();
  });

  it("pauses on backpressure until the stream drains", () => {
    const { advance, controller, stream } = setup();
    controller.start("manual");
    stream.acceptWrites = false;
    advance(FRAME_INTERVAL_MS + 1);
    const stalled = stream.writes.length;

    advance(FRAME_INTERVAL_MS * 3);
    expect(stream.writes).toHaveLength(stalled);
    expect(controller.status().waitingForDrain).toBeTruthy();

    stream.acceptWrites = true;
    stream.emitDrain();
    advance(FRAME_INTERVAL_MS + 1);
    expect(stream.writes.length).toBeGreaterThan(stalled);
  });

  it("re-places the control image after a resize settles", () => {
    let resized = false;
    const { advance, controller, stream } = setup({
      layout: () =>
        resized
          ? {
              columns: 81,
              phaseX: 0,
              phaseY: 0,
              pixelHeight: 432,
              pixelWidth: 729,
              rows: 24,
            }
          : makeLayout(720),
      metrics: () => ({
        ...makeMetrics(),
        columns: resized ? 81 : 80,
      }),
    });
    controller.start("manual");

    resized = true;
    advance(FRAME_INTERVAL_MS + 1);
    const controlWrites = () =>
      stream.writes.filter((write) => write.includes("o=z,"));
    expect(controlWrites()).toHaveLength(1);

    advance(150);
    expect(controlWrites()).toHaveLength(2);
  });

  it("stops and records the error when the re-layout fails", () => {
    let failLayout = false;
    const { advance, controller } = setup({
      layout: () => {
        if (failLayout) {
          throw new Error("layout exploded");
        }
        return makeLayout();
      },
      metrics: () => {
        if (failLayout) {
          return { ...makeMetrics(), columns: 81 };
        }
        return makeMetrics();
      },
    });
    controller.start("manual");
    failLayout = true;
    advance(FRAME_INTERVAL_MS + 1);

    const status = controller.status();
    expect(status.running).toBeFalsy();
    expect(status.lastError).toBe("layout exploded");
  });

  it("ignores repeated starts", () => {
    const { controller, stream } = setup();
    controller.start("manual");
    controller.start("auto");
    expect(
      stream.writes.filter((write) => write.includes("o=z,"))
    ).toHaveLength(1);
    expect(controller.status().mode).toBe("manual");
  });
});
