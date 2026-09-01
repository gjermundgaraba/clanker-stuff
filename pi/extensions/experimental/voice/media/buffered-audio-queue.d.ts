export class BufferedAudioQueue {
  phase: "buffering" | "replaying" | "live";

  constructor(options: {
    capacitySamples: number;
    leadingSilenceThreshold: number;
    preRollSamples: number;
  });

  process(input: Float32Array | undefined, output: Float32Array): void;
  release(): void;
}
