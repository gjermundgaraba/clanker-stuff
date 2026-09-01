export class BrowserMediaSession {
  #channel;
  #closed = false;
  #connected = false;
  #configured;
  #peer = new RTCPeerConnection();
  #ready;

  constructor(options) {
    this.options = options;
    this.#channel = this.#peer.createDataChannel("oai-events");
    this.#ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.#configured = new Promise((resolve, reject) => {
      this.resolveConfigured = resolve;
      this.rejectConfigured = reject;
    });

    for (const track of options.stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (!this.#closed) {
          this.#fail(new Error("Microphone disconnected."));
        }
      });
      this.#peer.addTrack(track, options.stream);
    }
    this.#peer.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      options.audioElement.srcObject = stream;
      options.onRemoteStream?.(stream);
      event.track.addEventListener("ended", () => {
        if (!this.#closed) {
          this.#fail(new Error("Voice audio output disconnected."));
        }
      });
    };
    this.#peer.onconnectionstatechange = () => {
      if (this.#peer.connectionState === "connected" && !this.#connected) {
        this.#connected = true;
        options.onConnected?.();
      }
      if (
        this.#peer.connectionState === "failed" ||
        this.#peer.connectionState === "disconnected"
      ) {
        this.#fail(new Error(`WebRTC connection ${this.#peer.connectionState}.`));
      }
    };
    this.#channel.addEventListener("open", () => {
      this.resolveReady();
      options.onEvent({ type: "data-open" });
    });
    this.#channel.addEventListener("close", () => {
      if (!this.#closed) {
        this.#fail(new Error("Realtime data channel closed."));
      }
    });
    this.#channel.addEventListener("error", () => {
      this.#fail(new Error("Realtime data channel failed."));
    });
    this.#channel.addEventListener("message", (event) => {
      this.#handleMessage(event.data);
    });
  }

  async createOffer() {
    const offer = await this.#peer.createOffer();
    await this.#peer.setLocalDescription(offer);
    if (!offer.sdp) {
      throw new Error("WebRTC did not create an SDP offer.");
    }
    return offer.sdp;
  }

  async acceptAnswer(answer) {
    await this.#peer.setRemoteDescription({ sdp: answer, type: "answer" });
    await withTimeout(this.#ready, 10_000, "Realtime data channel did not open.");
  }

  waitUntilConfigured() {
    return withTimeout(this.#configured, 10_000, "Realtime session was not configured.");
  }

  setMuted(muted) {
    for (const track of this.options.stream.getAudioTracks()) {
      track.enabled = !muted;
    }
  }

  close() {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      this.#channel.close();
    } catch {
      // Already closed.
    }
    try {
      this.#peer.close();
    } catch {
      // Already closed.
    }
    this.options.audioElement.srcObject = null;
  }

  #handleMessage(raw) {
    try {
      const event = JSON.parse(String(raw));
      if (!(event instanceof Object) || Array.isArray(event)) {
        return;
      }
      if (event.type === "session.started" || event.type === "session.updated") {
        this.resolveConfigured();
      }
      const parsed = parseMediaEvent(event);
      if (parsed) {
        this.options.onEvent(parsed);
      }
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #fail(error) {
    this.rejectReady(error);
    this.rejectConfigured(error);
    this.options.onEvent({ message: error.message, type: "error" });
  }
}

const parseMediaEvent = (event) => {
  if (event.type === "session.usage.updated" && event.usage_limit?.status === "approaching") {
    return { type: "usage-warning" };
  }
  if (event.type === "error") {
    return {
      message:
        event.error?.message?.constructor === String
          ? event.error.message
          : "Unknown realtime error.",
      type: "error",
    };
  }
};

const withTimeout = (promise, timeoutMs, message) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
