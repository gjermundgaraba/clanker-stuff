const copyInput = (input, output, start = 0) => {
  if (!input) {
    return;
  }
  for (
    let index = start;
    index < output.length && index < input.length;
    index += 1
  ) {
    output[index] = input[index] ?? 0;
  }
};

export class BufferedAudioQueue {
  constructor(options) {
    this.options = options;
    this.samples = new Float32Array(options.capacitySamples);
    this.length = 0;
    this.phase = "buffering";
    this.readOffset = 0;
  }

  process(input, output) {
    output.fill(0);
    if (this.phase === "buffering") {
      this.#append(input);
      return;
    }
    if (this.phase === "live") {
      copyInput(input, output);
      return;
    }

    if (this.#hasSignal(input)) {
      this.#append(input);
    }
    for (let index = 0; index < output.length; index += 1) {
      if (this.length === 0) {
        this.phase = "live";
        copyInput(input, output, index);
        break;
      }
      output[index] = this.#shift();
    }
    if (this.length === 0) {
      this.phase = "live";
    }
  }

  release() {
    if (this.phase !== "buffering") {
      return;
    }
    const firstSignalOffset = this.#findFirstSignalOffset();
    if (firstSignalOffset === null) {
      this.length = 0;
      this.phase = "live";
      return;
    }
    const discarded = Math.max(
      0,
      firstSignalOffset - this.options.preRollSamples
    );
    this.readOffset =
      (this.readOffset + discarded) % this.options.capacitySamples;
    this.length -= discarded;
    this.phase = "replaying";
  }

  #append(input) {
    if (!input) {
      return;
    }
    for (const sample of input) {
      if (this.length === this.options.capacitySamples) {
        this.readOffset = (this.readOffset + 1) % this.options.capacitySamples;
        this.length -= 1;
      }
      const writeOffset =
        (this.readOffset + this.length) % this.options.capacitySamples;
      this.samples[writeOffset] = sample;
      this.length += 1;
    }
  }

  #findFirstSignalOffset() {
    for (let index = 0; index < this.length; index += 1) {
      const offset = (this.readOffset + index) % this.options.capacitySamples;
      if (
        Math.abs(this.samples[offset] ?? 0) >=
        this.options.leadingSilenceThreshold
      ) {
        return index;
      }
    }
    return null;
  }

  #hasSignal(input) {
    return (
      input?.some(
        (sample) => Math.abs(sample) >= this.options.leadingSilenceThreshold
      ) ?? false
    );
  }

  #shift() {
    const sample = this.samples[this.readOffset] ?? 0;
    this.readOffset = (this.readOffset + 1) % this.options.capacitySamples;
    this.length -= 1;
    return sample;
  }
}
