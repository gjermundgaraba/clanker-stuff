/* eslint-disable func-style, promise/avoid-new */

import { CallLifecycle } from "./call-lifecycle.js";
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
let session;
let microphone;
let sessionStream;
let activeAudio = initialAudio;
let muted = false;
let reconnectTimer = 0;
let reconnectDelayMs = RECONNECT_MIN_MS;
let renewing = false;
let renewalController;
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
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Voice request cancelled.")
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
      ...(offer === undefined ? {} : { offer }),
      type: "request",
    });
  });
}

function render() {
  const listening = lifecycle.state === "active" && !muted;
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
    typeof RTCPeerConnection !== "function" ||
    typeof AudioContext !== "function" ||
    typeof AudioWorkletNode !== "function"
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
      new URL("realtime-buffered-audio-worklet.js", import.meta.url)
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
        // MessagePort.postMessage has no targetOrigin argument.
        // eslint-disable-next-line unicorn/require-post-message-target-origin
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
  let candidate;
  setDetail("Opening microphone.");

  try {
    const nextMicrophone = await lifecycle.wait(
      attempt,
      openMicrophone(),
      (lateMicrophone) => {
        lateMicrophone.close();
      }
    );
    microphone = nextMicrophone;
    sessionStream = nextMicrophone.createStream();
    lifecycle.markNegotiating(attempt);
    setDetail("Connecting.");

    candidate = new BrowserMediaSession({
      audioElement: activeAudio,
      onConnected: () => {
        nextMicrophone.release();
      },
      onEvent: handleMediaEvent,
      stream: sessionStream,
    });
    const offer = await lifecycle.wait(attempt, candidate.createOffer());
    const answer = await lifecycle.wait(
      attempt,
      request("offer", offer, attempt.signal)
    );
    await lifecycle.wait(attempt, candidate.acceptAnswer(answer));
    await lifecycle.wait(attempt, candidate.waitUntilConfigured());

    lifecycle.markActive(attempt);
    session = candidate;
    candidate = undefined;
    muted = false;
    reconnectDelayMs = RECONNECT_MIN_MS;
    setDetail("Listening. Click to pause.");
  } catch (error) {
    trace("call-error", {
      message: error instanceof Error ? error.message : String(error),
    });
    candidate?.close();
    lifecycle.fail(attempt, error);
    cleanupMedia();
    send({
      event: "error",
      message: error instanceof Error ? error.message : String(error),
      type: "event",
    });
    send({ event: "end", type: "event" });
    lifecycle.finishClose();
    setDetail(
      `Could not start: ${error instanceof Error ? error.message : String(error)}`
    );
    scheduleReconnect();
  }
}

async function runCutover() {
  if (renewing || lifecycle.state !== "active" || !session || !microphone) {
    return;
  }
  const originSession = session;
  const originMicrophone = microphone;
  const controller = new AbortController();
  renewalController = controller;
  const isCurrent = () =>
    lifecycle.state === "active" &&
    session === originSession &&
    microphone === originMicrophone;
  const requireCurrent = () => {
    if (!isCurrent()) {
      throw new Error("Voice renewal was cancelled.");
    }
  };
  renewing = true;
  let warm;
  let warmStream;
  try {
    warmStream = originMicrophone.createStream(false);
    const warmAudio = document.createElement("audio");
    warmAudio.autoplay = true;
    warmAudio.muted = true;
    const warmSession = new BrowserMediaSession({
      audioElement: warmAudio,
      onEvent: (event) => {
        if (session === warmSession) {
          handleMediaEvent(event);
        }
      },
      stream: warmStream,
    });
    warm = warmSession;
    const offer = await warmSession.createOffer();
    requireCurrent();
    const answer = await request("renew_offer", offer, controller.signal);
    await warmSession.acceptAnswer(answer);
    await warmSession.waitUntilConfigured();
    requireCurrent();

    const [warmTrack] = warmStream.getAudioTracks();
    if (!warmTrack) {
      throw new Error("Replacement call has no microphone track.");
    }
    await request("renew_commit", undefined, controller.signal);
    requireCurrent();
    warmTrack.enabled = !muted;
    warmAudio.muted = false;
    const previousSession = session;
    const previousStream = sessionStream;
    session = warmSession;
    sessionStream = warmStream;
    activeAudio = warmAudio;
    warm = undefined;
    warmStream = undefined;
    previousSession.close();
    for (const track of previousStream?.getTracks() ?? []) {
      track.stop();
    }
  } catch (error) {
    send({ event: "renew_abort", type: "event" });
    warm?.close();
    for (const track of warmStream?.getTracks() ?? []) {
      track.stop();
    }
    setDetail(
      `Renewal failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    controller.abort(new Error("Voice renewal finished."));
    if (renewalController === controller) {
      renewalController = undefined;
    }
    renewing = false;
  }
}

function cleanupMedia() {
  renewalController?.abort(new Error("Voice call closed."));
  session?.close();
  session = undefined;
  for (const track of sessionStream?.getTracks() ?? []) {
    track.stop();
  }
  sessionStream = undefined;
  microphone?.close();
  microphone = undefined;
  muted = false;
  activeAudio.pause();
  activeAudio.srcObject = null;
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
  if (lifecycle.state === "active" && session) {
    muted = !muted;
    session.setMuted(muted);
    send({ event: "muted", muted, type: "event" });
    setDetail(
      muted ? "Paused. Click to resume." : "Listening. Click to pause."
    );
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
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.type === "response" && typeof message.id === "number") {
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
