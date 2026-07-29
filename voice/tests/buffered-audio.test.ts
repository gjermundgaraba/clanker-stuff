import { describe, expect, it } from "vitest";

interface AudioQueue {
  phase: string;
  process: (input: Float32Array | undefined, output: Float32Array) => void;
  release: () => void;
}

type AudioQueueConstructor = new (options: {
  capacitySamples: number;
  leadingSilenceThreshold: number;
  preRollSamples: number;
}) => AudioQueue;

const loadQueue = async (): Promise<AudioQueueConstructor> => {
  const modulePath = "../media/buffered-audio-queue.js";
  const imported: unknown = await import(modulePath);
  if (
    imported === null ||
    typeof imported !== "object" ||
    !("BufferedAudioQueue" in imported) ||
    typeof imported.BufferedAudioQueue !== "function"
  ) {
    throw new Error("BufferedAudioQueue was not exported.");
  }
  return imported.BufferedAudioQueue as AudioQueueConstructor;
};

describe("buffered microphone audio", () => {
  it("replays from before speech and then returns to live audio", async () => {
    const BufferedAudioQueue = await loadQueue();
    const queue = new BufferedAudioQueue({
      capacitySamples: 12,
      leadingSilenceThreshold: 0.003,
      preRollSamples: 2,
    });
    const initialOutput = new Float32Array(6);

    queue.process(
      Float32Array.from([0, 0, 0, 0.001, 0.01, 0.02]),
      initialOutput
    );
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
