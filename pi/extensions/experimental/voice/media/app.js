import { CallLifecycle } from "./call-lifecycle.js";
import { commitRenewal, createCall, disposeCallMedia, disposeLeg } from "./call-media.js";
import { BrowserMediaSession } from "./media-session.js";

const CALL_START_TIMEOUT_MS = 25_000;
const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30_000;

const orb = document.querySelector("#orb");
const initialAudio = document.querySelector("#remote-audio");
if (!orb || !initialAudio) {
  throw new Error("Voice media page is incomplete.");
}

const lifecycle = new CallLifecycle(CALL_START_TIMEOUT_MS);
const pendingRequests = new Map();
let nextRequestId = 0;
let currentCall;
let reconnectTimer = 0;
let reconnectDelayMs = RECONNECT_MIN_MS;
let detail = "Starting.";
let researchConfig = {};

function send(message) {
  window.piVoice.send(message);
}

function trace(kind, data) {
  if (researchConfig.trace) {
    send({ data, event: "trace", kind, type: "event" });
  }
}

function request(method, offer, signal) {
  nextRequestId += 1;
  const id = nextRequestId;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      const pending = pendingRequests.get(id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      signal?.removeEventListener("abort", pending.onAbort);
      pendingRequests.delete(id);
    };
    const rejectAndCleanup = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      rejectAndCleanup(
        signal.reason instanceof Error ? signal.reason : new Error("Voice request cancelled."),
      );
    };
    const timeout = setTimeout(() => {
      rejectAndCleanup(new Error(`Voice ${method} request timed out.`));
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(id, {
      onAbort,
      reject: rejectAndCleanup,
      resolve: (value) => {
        cleanup();
        resolve(value);
      },
      timeout,
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    send({
      id,
      method,
      offer,
      type: "request",
    });
  });
}

function render() {
  const listening = lifecycle.state === "active" && currentCall && !currentCall.muted;
  orb.className = `orb ${listening ? "listening" : "paused"}`;
  orb.title = `Pi Voice — ${detail}`;
  orb.setAttribute("aria-label", orb.title);
}

function setDetail(value) {
  detail = value;
  render();
}

async function openMicrophone() {
  if (
    !isSecureContext ||
    !navigator.mediaDevices?.getUserMedia ||
    !globalThis.RTCPeerConnection ||
    !globalThis.AudioContext ||
    !globalThis.AudioWorkletNode
  ) {
    throw new Error("Microphone access is unavailable.");
  }
  const supported = navigator.mediaDevices.getSupportedConstraints();
  const constraints = { channelCount: 1 };
  if (supported.noiseSuppression) {
    constraints.noiseSuppression = true;
  }
  const permissionStream = await navigator.mediaDevices.getUserMedia({
    audio: constraints,
  });
  const context = new AudioContext();
  try {
    await context.audioWorklet.addModule(
      new URL("realtime-buffered-audio-worklet.js", import.meta.url),
    );
    const source = context.createMediaStreamSource(permissionStream);
    const worklet = new AudioWorkletNode(context, "pi-voice-buffered-audio", {
      channelCount: 1,
      channelCountMode: "explicit",
      outputChannelCount: [1],
    });
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 1;
    source.connect(worklet);
    worklet.connect(destination);
    await context.resume();
    return {
      close() {
        source.disconnect();
        worklet.disconnect();
        for (const track of permissionStream.getTracks()) {
          track.stop();
        }
        for (const track of destination.stream.getTracks()) {
          track.stop();
        }
        void context.close();
      },
      createStream(enabled = true) {
        const [outputTrack] = destination.stream.getAudioTracks();
        if (!outputTrack) {
          throw new Error("Buffered microphone produced no audio track.");
        }
        const track = outputTrack.clone();
        track.enabled = enabled;
        return new MediaStream([track]);
      },
      release() {
        worklet.port.postMessage({ type: "release" });
      },
    };
  } catch (error) {
    for (const track of permissionStream.getTracks()) {
      track.stop();
    }
    void context.close();
    throw error;
  }
}

function handleMediaEvent(event) {
  if (event.type === "data-open") {
    send({ event: "media_ready", type: "event" });
  } else if (event.type === "usage-warning") {
    send({ event: "usage_warning", type: "event" });
  } else if (event.type === "error") {
    if (lifecycle.state === "active") {
      releaseCall(`Realtime error: ${event.message}`);
    } else {
      setDetail(`Realtime error: ${event.message}`);
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0;
    void startCall();
  }, delay);
}

function cancelReconnect() {
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
  }
  reconnectTimer = 0;
}

async function startCall() {
  if (lifecycle.state !== "closed") {
    return;
  }
  trace("call-start", {});
  cancelReconnect();
  const attempt = lifecycle.beginStart();
  let candidateCall;
  let candidateLeg;
  let candidateMicrophone;
  let candidateStream;
  setDetail("Opening microphone.");

  try {
    const nextMicrophone = await lifecycle.wait(attempt, openMicrophone(), (lateMicrophone) => {
      lateMicrophone.close();
    });
    candidateMicrophone = nextMicrophone;
    const nextStream = nextMicrophone.createStream();
    candidateStream = nextStream;
    lifecycle.markNegotiating(attempt);
    setDetail("Connecting.");

    const candidate = new BrowserMediaSession({
      audioElement: initialAudio,
      onConnected: () => {
        nextMicrophone.release();
      },
      onEvent: (event) => {
        if (currentCall === candidateCall && candidateCall?.leg.session === candidate) {
          handleMediaEvent(event);
        }
      },
      stream: nextStream,
    });
    candidateLeg = {
      audio: initialAudio,
      session: candidate,
      stream: nextStream,
    };
    candidateCall = createCall(nextMicrophone, candidateLeg);
    candidateLeg = undefined;
    candidateMicrophone = undefined;
    candidateStream = undefined;
    currentCall = candidateCall;

    const offer = await lifecycle.wait(attempt, candidate.createOffer());
    const answer = await lifecycle.wait(attempt, request("offer", offer, attempt.signal));
    await lifecycle.wait(attempt, candidate.acceptAnswer(answer));
    await lifecycle.wait(attempt, candidate.waitUntilConfigured());

    lifecycle.markActive(attempt);
    reconnectDelayMs = RECONNECT_MIN_MS;
    setDetail("Listening. Click to pause.");
  } catch (error) {
    trace("call-error", {
      message: error instanceof Error ? error.message : String(error),
    });
    lifecycle.fail(attempt, error);
    if (currentCall === candidateCall) {
      currentCall = undefined;
    }
    disposeCallMedia(candidateCall, error);
    disposeLeg(candidateLeg);
    for (const track of candidateStream?.getTracks() ?? []) {
      track.stop();
    }
    candidateMicrophone?.close();
    send({
      event: "error",
      message: error instanceof Error ? error.message : String(error),
      type: "event",
    });
    send({ event: "end", type: "event" });
    lifecycle.finishClose();
    setDetail(`Could not start: ${error instanceof Error ? error.message : String(error)}`);
    scheduleReconnect();
  }
}

async function runCutover() {
  const originCall = currentCall;
  if (lifecycle.state !== "active" || !originCall || originCall.renewal) {
    return;
  }

  const isCurrent = () => lifecycle.state === "active" && currentCall === originCall;
  const requireCurrent = () => {
    if (!isCurrent()) {
      throw new Error("Voice renewal was cancelled.");
    }
  };

  let controller;
  let renewal;
  let warmLeg;
  let warmStream;
  let committed = false;
  try {
    warmStream = originCall.microphone.createStream(false);
    const warmAudio = document.createElement("audio");
    warmAudio.autoplay = true;
    warmAudio.muted = true;
    const warmSession = new BrowserMediaSession({
      audioElement: warmAudio,
      onEvent: (event) => {
        if (currentCall === originCall && originCall.leg === warmLeg) {
          handleMediaEvent(event);
        }
      },
      stream: warmStream,
    });
    warmLeg = {
      audio: warmAudio,
      session: warmSession,
      stream: warmStream,
    };
    warmStream = undefined;
    controller = new AbortController();
    renewal = { controller, warmLeg };
    originCall.renewal = renewal;

    const offer = await warmSession.createOffer();
    requireCurrent();
    const answer = await request("renew_offer", offer, controller.signal);
    await warmSession.acceptAnswer(answer);
    await warmSession.waitUntilConfigured();
    requireCurrent();

    const [warmTrack] = warmLeg.stream.getAudioTracks();
    if (!warmTrack) {
      throw new Error("Replacement call has no microphone track.");
    }
    await request("renew_commit", undefined, controller.signal);
    requireCurrent();
    warmTrack.enabled = !originCall.muted;
    warmAudio.muted = false;
    const previousLeg = commitRenewal(originCall, renewal);
    committed = true;
    disposeLeg(previousLeg);
  } catch (error) {
    send({ event: "renew_abort", type: "event" });
    for (const track of warmStream?.getTracks() ?? []) {
      track.stop();
    }
    disposeLeg(warmLeg);
    setDetail(`Renewal failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    controller?.abort(new Error("Voice renewal finished."));
    if (originCall.renewal === renewal) {
      originCall.renewal = undefined;
    }
    if (!committed) {
      disposeLeg(warmLeg);
    }
  }
}

function cleanupMedia() {
  const closingCall = currentCall;
  currentCall = undefined;
  disposeCallMedia(closingCall, new Error("Voice call closed."));
}

function releaseCall(reason) {
  lifecycle.beginStop(reason);
  cleanupMedia();
  send({ event: "end", type: "event" });
  lifecycle.finishClose();
  setDetail(`${reason} Reconnecting.`);
  scheduleReconnect();
}

orb.addEventListener("click", () => {
  if (lifecycle.state === "closed") {
    void startCall();
    return;
  }
  if (lifecycle.state === "active" && currentCall) {
    currentCall.muted = !currentCall.muted;
    currentCall.leg.session.setMuted(currentCall.muted);
    send({ event: "muted", muted: currentCall.muted, type: "event" });
    setDetail(currentCall.muted ? "Paused. Click to resume." : "Listening. Click to pause.");
  }
});

window.addEventListener("beforeunload", () => {
  for (const pending of pendingRequests.values()) {
    pending.reject(new Error("Voice window closed."));
  }
  cancelReconnect();
  if (lifecycle.state !== "closed") {
    lifecycle.beginStop("Window closed.");
    cleanupMedia();
    send({ event: "end", type: "event" });
    lifecycle.finishClose();
  }
});

window.piVoice.onMessage((message) => {
  if (!(message instanceof Object)) {
    return;
  }
  if (message.type === "response" && Number.isInteger(message.id)) {
    const pending = pendingRequests.get(message.id);
    if (!pending) {
      return;
    }
    if (message.ok) {
      pending.resolve(message.value);
    } else {
      pending.reject(new Error(message.error || "Voice request failed."));
    }
    return;
  }
  if (message.type !== "event") {
    return;
  }
  if (message.event === "renew_due") {
    void runCutover();
  } else if (message.event === "error") {
    setDetail(`Voice error: ${message.message}`);
  } else if (
    message.event === "state" &&
    message.state === "failed" &&
    lifecycle.state === "active"
  ) {
    releaseCall("The voice call failed.");
  }
});

researchConfig = await window.piVoice.getResearchConfig();
render();
void startCall();
