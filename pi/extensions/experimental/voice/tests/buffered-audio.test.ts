import { describe, expect, it } from "vite-plus/test";

describe("buffered microphone audio", () => {
  it("replays from before speech and then returns to live audio", async () => {
    const { BufferedAudioQueue } = await import("../media/buffered-audio-queue.js");
    const queue = new BufferedAudioQueue({
      capacitySamples: 12,
      leadingSilenceThreshold: 0.003,
      preRollSamples: 2,
    });
    const initialOutput = new Float32Array(6);

    queue.process(Float32Array.from([0, 0, 0, 0.001, 0.01, 0.02]), initialOutput);
    expect([...initialOutput]).toStrictEqual([0, 0, 0, 0, 0, 0]);

    queue.release();
    const replay = new Float32Array(4);
    queue.process(Float32Array.from([0, 0, 0, 0]), replay);

    expect([...replay]).toStrictEqual([
      expect.closeTo(0, 5),
      expect.closeTo(0.001, 5),
      expect.closeTo(0.01, 5),
      expect.closeTo(0.02, 5),
    ]);
    expect(queue.phase).toBe("live");
  });
});
