/* eslint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/strict-boolean-expressions */

import { BufferedAudioQueue } from "./buffered-audio-queue.js";

class RealtimeBufferedAudioProcessor extends AudioWorkletProcessor {
  queue = new BufferedAudioQueue({
    capacitySamples: sampleRate * 30,
    leadingSilenceThreshold: 0.003,
    preRollSamples: sampleRate * 0.1,
  });

  constructor() {
    super();
    this.port.addEventListener("message", (event) => {
      if (event.data?.type === "release") {
        this.queue.release();
      }
    });
    this.port.start();
  }

  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (output) {
      this.queue.process(inputs[0]?.[0], output);
    }
    return true;
  }
}

registerProcessor("pi-voice-buffered-audio", RealtimeBufferedAudioProcessor);
