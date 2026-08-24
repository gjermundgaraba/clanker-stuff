#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import pathModule from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

const { join, resolve: resolvePath } = pathModule;
const CODEX_APP = process.env.CODEX_APP_PATH ?? "/Applications/ChatGPT.app";
const CODEX_EXECUTABLE = `${CODEX_APP}/Contents/MacOS/ChatGPT`;
const CODEX_CLI = `${CODEX_APP}/Contents/Resources/codex`;
const CODEX_ASAR = `${CODEX_APP}/Contents/Resources/app.asar`;
const DEFAULT_CAPTURE_ROOT = `${process.env.HOME}/Library/Application Support/Pi Voice Research/captures`;
const SOURCE_DIRECTORY = import.meta.dirname;
const PROXY = join(SOURCE_DIRECTORY, "codex-cli-proxy.mjs");
const TARGET_POLL_MS = 500;
const NETWORK_URL_PATTERN = /(?:codex|realtime|quicksilver|statsig|feature|voice|openai)/iu;
const CdpResponseSchema = Type.Object(
  {
    error: Type.Optional(Type.Unknown()),
    id: Type.Number(),
    result: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);
const CdpEventSchema = Type.Object(
  {
    method: Type.String(),
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: true },
);
const CdpVersionSchema = Type.Object(
  {
    webSocketDebuggerUrl: Type.String(),
  },
  { additionalProperties: true },
);
const CdpTargetsSchema = Type.Array(
  Type.Object(
    {
      id: Type.String(),
      type: Type.String(),
      webSocketDebuggerUrl: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
  ),
);
const RendererBindingPayloadSchema = Type.Object(
  {
    detail: Type.Optional(Type.Unknown()),
    kind: Type.String(),
  },
  { additionalProperties: true },
);
const RendererMediaChunkPayloadSchema = Type.Object(
  {
    detail: Type.Object(
      {
        data: Type.String(),
        streamId: Type.String(),
      },
      { additionalProperties: true },
    ),
    kind: Type.Literal("media-chunk"),
  },
  { additionalProperties: true },
);

const sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const monotonicNs = () => process.hrtime.bigint().toString();

const timestampStem = () => new Date().toISOString().replaceAll(/[:.]/gu, "-").replace("Z", "Z");

const hashFile = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || !("port" in address)) {
        reject(new Error("Could not allocate a CDP port."));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });

const commandOutput = (command, arguments_) => {
  const result = spawnSync(command, arguments_, {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    exitCode: result.status,
    stderr: result.stderr?.trim() ?? "",
    stdout: result.stdout?.trim() ?? "",
  };
};

class NdjsonWriter {
  constructor(filePath) {
    this.output = createWriteStream(filePath, { mode: 0o600 });
    this.sequence = 0;
  }

  write(event) {
    this.sequence += 1;
    this.output.write(
      `${JSON.stringify({
        ...event,
        monotonicNs: monotonicNs(),
        sequence: this.sequence,
        timestamp: new Date().toISOString(),
      })}\n`,
    );
  }

  close() {
    this.output.end();
  }
}

class CdpClient {
  nextId = 0;
  pending = new Map();

  constructor(url, onEvent) {
    this.onEvent = onEvent;
    this.socket = new WebSocket(url);
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener(
        "error",
        () => reject(new Error("CDP WebSocket failed to open.")),
        { once: true },
      );
      this.socket.addEventListener("message", (event) => {
        this.handleMessage(event.data);
      });
      this.socket.addEventListener("close", () => {
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new Error("CDP WebSocket closed."));
        }
        this.pending.clear();
      });
    });
  }

  send(method, params = {}) {
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }

  handleMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (Value.Check(CdpResponseSchema, parsed)) {
      const message = parsed;
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (Value.Check(CdpEventSchema, parsed)) {
      const message = parsed;
      this.onEvent(message.method, message.params ?? {});
    }
  }
}

export class TargetAttachmentRegistry {
  constructor(attach, onAttachError) {
    this.attach = attach;
    this.onAttachError = onAttachError;
    this.stopped = false;
    this.targets = new Map();
  }

  claim(target) {
    const current = this.targets.get(target.id);
    if (current?.webSocketDebuggerUrl === target.webSocketDebuggerUrl && !this.stopped) {
      return { claimed: false, promise: current.promise };
    }

    if (current) {
      this.#retire(current);
    }
    if (this.stopped) {
      return { claimed: false, promise: Promise.resolve(undefined) };
    }

    const ownership = {
      client: undefined,
      promise: undefined,
      status: "attaching",
      webSocketDebuggerUrl: target.webSocketDebuggerUrl,
    };
    const isOwner = () => !this.stopped && this.targets.get(target.id) === ownership;
    const promise = Promise.resolve().then(() => this.attach(target, isOwner));
    ownership.promise = promise;
    this.targets.set(target.id, ownership);

    void promise.then(
      (client) => {
        if (!isOwner()) {
          client?.close();
          return;
        }
        ownership.client = client;
        ownership.status = "attached";
      },
      (error) => {
        const ownsTarget = this.targets.get(target.id) === ownership;
        if (ownsTarget) {
          this.targets.delete(target.id);
        }
        if (!this.stopped && ownsTarget) {
          this.onAttachError(error instanceof Error ? error : new Error(String(error)), target);
        }
      },
    );

    return { claimed: true, promise };
  }

  stop() {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    for (const ownership of this.targets.values()) {
      this.#retire(ownership);
    }
    this.targets.clear();
  }

  #retire(ownership) {
    ownership.client?.close();
  }
}

const rendererHook = (configuration = {}) => {
  if (globalThis.__codexVoiceRecorderInstalled) {
    return;
  }
  globalThis.__codexVoiceRecorderInstalled = true;
  let nextPeerId = 0;
  let nextStreamId = 0;
  let latestAudioContext;
  const streamIds = new WeakMap();
  const recorders = [];

  const emit = (kind, detail = {}) => {
    try {
      globalThis.__codexVoiceTrace(
        JSON.stringify({
          detail,
          kind,
          pageTimestamp: new Date().toISOString(),
          performanceNow: performance.now(),
        }),
      );
    } catch {
      // The CDP binding may disappear while the page closes.
    }
  };

  const streamDetail = (stream) => ({
    active: stream.active,
    id: stream.id,
    tracks: stream.getTracks().map((track) => ({
      enabled: track.enabled,
      id: track.id,
      kind: track.kind,
      label: track.label,
      muted: track.muted,
      readyState: track.readyState,
      settings: track.getSettings?.(),
    })),
  });

  const captureStream = (stream, capturePoint) => {
    if (!stream || globalThis.MediaRecorder === undefined) {
      emit("media-recorder-unavailable", { capturePoint });
      return;
    }
    let streamId = streamIds.get(stream);
    if (!streamId) {
      nextStreamId += 1;
      streamId = `${capturePoint}-${nextStreamId}`;
      streamIds.set(stream, streamId);
    }
    try {
      const options = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? { mimeType: "audio/webm;codecs=opus" }
        : undefined;
      const recorder = new MediaRecorder(stream, options);
      recorder.addEventListener("dataavailable", async (event) => {
        if (event.data.size === 0) {
          return;
        }
        const bytes = new Uint8Array(await event.data.arrayBuffer());
        let binary = "";
        for (const byte of bytes) {
          binary += String.fromCodePoint(byte);
        }
        emit("media-chunk", {
          capturePoint,
          data: btoa(binary),
          mimeType: recorder.mimeType,
          streamId,
        });
      });
      recorder.addEventListener("error", (event) => {
        emit("media-recorder-error", {
          capturePoint,
          message: event.error?.message ?? "unknown",
          streamId,
        });
      });
      recorder.addEventListener("stop", () => {
        emit("media-recorder-stop", { capturePoint, streamId });
      });
      recorder.start(1000);
      recorders.push(recorder);
      emit("media-recorder-start", {
        capturePoint,
        mimeType: recorder.mimeType,
        stream: streamDetail(stream),
        streamId,
      });
    } catch (error) {
      emit("media-recorder-error", {
        capturePoint,
        message: error instanceof Error ? error.message : String(error),
        streamId,
      });
    }
  };

  const instrumentDataChannel = (channel, peerId) => {
    const describe = () => ({
      id: channel.id,
      label: channel.label,
      negotiated: channel.negotiated,
      ordered: channel.ordered,
      peerId,
      protocol: channel.protocol,
      readyState: channel.readyState,
    });
    emit("data-channel-created", describe());
    for (const eventName of ["open", "close", "closing", "error"]) {
      channel.addEventListener(eventName, () => {
        emit(`data-channel-${eventName}`, describe());
      });
    }
    channel.addEventListener("message", (event) => {
      emit("data-channel-received", {
        ...describe(),
        data:
          event.data?.constructor === String
            ? event.data
            : { byteLength: event.data?.byteLength ?? null },
      });
    });
  };

  if (configuration.syntheticAudioBase64) {
    try {
      const NativeAudioContext = globalThis.AudioContext;
      globalThis.AudioContext = new Proxy(NativeAudioContext, {
        construct(Target, arguments_) {
          const context = Reflect.construct(Target, arguments_, Target);
          latestAudioContext = context;
          return context;
        },
      });
      emit("hook-installed", { hook: "AudioContext" });
    } catch (error) {
      emit("hook-failed", {
        hook: "AudioContext",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    const originalGetUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    if (originalGetUserMedia) {
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        emit("get-user-media-request", { constraints });
        try {
          let stream;
          if (configuration.syntheticAudioBase64) {
            const permissionStream = await originalGetUserMedia(constraints);
            const context = latestAudioContext ?? new AudioContext();
            const encoded = atob(configuration.syntheticAudioBase64);
            const bytes = Uint8Array.from(encoded, (character) => character.codePointAt(0));
            const buffer = await context.decodeAudioData(bytes.buffer);
            const source = context.createBufferSource();
            const destination = context.createMediaStreamDestination();
            source.buffer = buffer;
            source.connect(destination);
            source.start(context.currentTime + configuration.syntheticDelayMs / 1000);
            globalThis.__codexVoiceSyntheticAudio = {
              bufferDuration: buffer.duration,
              context,
              destination,
              permissionStream,
              source,
            };
            ({ stream } = destination);
            emit("synthetic-audio-scheduled", {
              delayMs: configuration.syntheticDelayMs,
              duration: buffer.duration,
            });
          } else {
            stream = await originalGetUserMedia(constraints);
          }
          emit("get-user-media-result", {
            stream: streamDetail(stream),
            synthetic: Boolean(configuration.syntheticAudioBase64),
          });
          captureStream(stream, "mic-source");
          return stream;
        } catch (error) {
          emit("get-user-media-error", {
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      };
      emit("hook-installed", { hook: "getUserMedia" });
    }
  } catch (error) {
    emit("hook-failed", {
      hook: "getUserMedia",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const NativePeerConnection = globalThis.RTCPeerConnection;
    if (NativePeerConnection) {
      globalThis.RTCPeerConnection = new Proxy(NativePeerConnection, {
        construct(Target, arguments_) {
          const peer = Reflect.construct(Target, arguments_, Target);
          nextPeerId += 1;
          const peerId = `peer-${nextPeerId}`;
          emit("peer-created", {
            configuration: arguments_[0],
            peerId,
          });
          peer.addEventListener("connectionstatechange", () => {
            emit("peer-connection-state", {
              connectionState: peer.connectionState,
              iceConnectionState: peer.iceConnectionState,
              iceGatheringState: peer.iceGatheringState,
              peerId,
              signalingState: peer.signalingState,
            });
          });
          peer.addEventListener("icecandidate", (event) => {
            emit("peer-ice-candidate", {
              candidate: event.candidate?.toJSON?.() ?? null,
              peerId,
            });
          });
          peer.addEventListener("datachannel", (event) => {
            instrumentDataChannel(event.channel, peerId);
          });
          peer.addEventListener("track", (event) => {
            emit("peer-track", {
              peerId,
              streams: event.streams.map(streamDetail),
              track: {
                id: event.track.id,
                kind: event.track.kind,
                label: event.track.label,
                settings: event.track.getSettings?.(),
              },
            });
            const stream = event.streams[0] ?? new MediaStream([event.track]);
            captureStream(stream, "remote-output");
          });

          const originalAddTrack = peer.addTrack.bind(peer);
          peer.addTrack = (track, ...streams) => {
            emit("peer-add-track", {
              peerId,
              streams: streams.map(streamDetail),
              track: {
                id: track.id,
                kind: track.kind,
                label: track.label,
                settings: track.getSettings?.(),
              },
            });
            for (const stream of streams) {
              captureStream(stream, "mic-sent");
            }
            return originalAddTrack(track, ...streams);
          };

          const originalCreateDataChannel = peer.createDataChannel.bind(peer);
          peer.createDataChannel = (...argumentsDataChannel) => {
            const channel = originalCreateDataChannel(...argumentsDataChannel);
            instrumentDataChannel(channel, peerId);
            const originalSend = channel.send.bind(channel);
            channel.send = (data) => {
              emit("data-channel-sent", {
                data:
                  data?.constructor === String ? data : { byteLength: data?.byteLength ?? null },
                id: channel.id,
                label: channel.label,
                peerId,
              });
              return originalSend(data);
            };
            return channel;
          };

          for (const method of ["createOffer", "setLocalDescription", "setRemoteDescription"]) {
            const original = peer[method].bind(peer);
            peer[method] = async (...methodArguments) => {
              emit(`peer-${method}-call`, {
                arguments: methodArguments,
                peerId,
              });
              const result = await original(...methodArguments);
              emit(`peer-${method}-result`, {
                peerId,
                result,
              });
              return result;
            };
          }

          const statsTimer = setInterval(async () => {
            if (peer.connectionState === "closed") {
              clearInterval(statsTimer);
              return;
            }
            try {
              const report = await peer.getStats();
              emit("webrtc-stats", {
                peerId,
                report: Array.from(report.values(), (entry) => ({
                  ...entry,
                })),
              });
            } catch (error) {
              emit("webrtc-stats-error", {
                message: error instanceof Error ? error.message : String(error),
                peerId,
              });
            }
          }, 1000);
          return peer;
        },
      });
      emit("hook-installed", { hook: "RTCPeerConnection" });
    }
  } catch (error) {
    emit("hook-failed", {
      hook: "RTCPeerConnection",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const bridge = globalThis.electronBridge;
    if (bridge?.sendMessageFromView) {
      const original = bridge.sendMessageFromView.bind(bridge);
      bridge.sendMessageFromView = async (...arguments_) => {
        emit("electron-bridge-send", { arguments: arguments_ });
        try {
          const result = await original(...arguments_);
          emit("electron-bridge-result", { result });
          return result;
        } catch (error) {
          emit("electron-bridge-error", {
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      };
      emit("hook-installed", { hook: "electronBridge.sendMessageFromView" });
    }
  } catch (error) {
    emit("hook-failed", {
      hook: "electronBridge.sendMessageFromView",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  addEventListener("beforeunload", () => {
    for (const recorder of recorders) {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    }
  });

  emit("recorder-installed", {
    globals: Object.keys(globalThis)
      .filter((key) => /codex|electron|realtime|voice/iu.test(key))
      .toSorted(),
    location: location.href,
    userAgent: navigator.userAgent,
  });
};

const getJson = async (url, schema) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}.`);
  }
  const value = await response.json();
  try {
    return Value.Parse(schema, value);
  } catch {
    throw new Error(`${url} returned an unexpected JSON response.`);
  }
};

const waitForCdp = async (port, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await getJson(`http://127.0.0.1:${port}/json/version`, CdpVersionSchema);
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }
  throw new Error(
    `Codex CDP did not start: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
};

const writeManifest = async (directory, port, runConfiguration) => {
  const appAsarBytes = statSync(CODEX_ASAR).size;
  const appAsarHash = await hashFile(CODEX_ASAR);
  const emptyHash = createHash("sha256").digest("hex");
  const info = {
    app: CODEX_APP,
    appAsar: {
      bytes: appAsarBytes,
      hashError:
        appAsarBytes > 0 && appAsarHash === emptyHash
          ? "Whole-file reads returned zero bytes; member and signature evidence remain authoritative."
          : undefined,
      path: CODEX_ASAR,
      sha256: appAsarBytes > 0 && appAsarHash === emptyHash ? null : appAsarHash,
    },
    appExecutable: {
      path: CODEX_EXECUTABLE,
      sha256: await hashFile(CODEX_EXECUTABLE),
    },
    build: commandOutput("defaults", ["read", `${CODEX_APP}/Contents/Info`, "CFBundleVersion"])
      .stdout,
    cdpPort: port,
    cli: {
      path: CODEX_CLI,
      sha256: await hashFile(CODEX_CLI),
      version: commandOutput(CODEX_CLI, ["--version"]).stdout,
    },
    codesign: commandOutput("codesign", ["-dv", "--verbose=4", CODEX_APP]),
    recorderCommit: commandOutput("git", [
      "-C",
      resolvePath(SOURCE_DIRECTORY, "../.."),
      "rev-parse",
      "HEAD",
    ]).stdout,
    recorderPath: import.meta.filename,
    runConfiguration,
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    version: commandOutput("defaults", [
      "read",
      `${CODEX_APP}/Contents/Info`,
      "CFBundleShortVersionString",
    ]).stdout,
  };
  writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(info, null, 2)}\n`, {
    mode: 0o600,
  });
};

const createProxyLauncher = (directory) => {
  const proxyPath = join(directory, "codex-cli-proxy");
  writeFileSync(
    proxyPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(PROXY)} "$@"\n`,
    { mode: 0o700 },
  );
  chmodSync(proxyPath, 0o700);
  return proxyPath;
};

const isRelevantNetworkEvent = (params) =>
  NETWORK_URL_PATTERN.test(params.request?.url ?? params.response?.url ?? params.url ?? "");

const attachTarget = async (
  target,
  directory,
  writer,
  mediaFiles,
  hookConfiguration,
  startVoice,
  isActive = () => true,
) => {
  const relevantRequestIds = new Set();
  const client = new CdpClient(target.webSocketDebuggerUrl, (method, params) => {
    if (!isActive()) {
      return;
    }
    if (method === "Runtime.bindingCalled") {
      let payload;
      try {
        payload = Value.Parse(RendererBindingPayloadSchema, JSON.parse(params.payload));
      } catch {
        payload = { kind: "invalid-binding-payload", raw: params.payload };
      }
      if (Value.Check(RendererMediaChunkPayloadSchema, payload)) {
        const { detail } = Value.Parse(RendererMediaChunkPayloadSchema, payload);
        const key = `${target.id}:${detail.streamId}`;
        let output = mediaFiles.get(key);
        if (!output) {
          const safeName = String(detail.streamId).replaceAll(/[^\dA-Za-z_.-]/gu, "_");
          output = createWriteStream(join(directory, `${target.id}-${safeName}.webm`), {
            mode: 0o600,
          });
          mediaFiles.set(key, output);
        }
        const bytes = Buffer.from(detail.data, "base64");
        output.write(bytes);
        writer.write({
          detail: {
            ...detail,
            bytes: bytes.length,
            data: undefined,
          },
          kind: payload.kind,
          source: "renderer-binding",
          targetId: target.id,
        });
        return;
      }
      writer.write({
        ...payload,
        source: "renderer-binding",
        targetId: target.id,
      });
      return;
    }

    if (
      (method === "Network.requestWillBeSent" || method === "Network.responseReceived") &&
      isRelevantNetworkEvent(params)
    ) {
      relevantRequestIds.add(params.requestId);
    }

    if (
      method.startsWith("Network.webSocket") ||
      (method.startsWith("Network.") && isRelevantNetworkEvent(params)) ||
      method === "Runtime.consoleAPICalled" ||
      method === "Runtime.exceptionThrown"
    ) {
      writer.write({
        kind: method,
        params,
        source: "cdp",
        targetId: target.id,
      });
    }

    if (method === "Network.loadingFinished" && relevantRequestIds.has(params.requestId)) {
      relevantRequestIds.delete(params.requestId);
      void client
        .send("Network.getResponseBody", { requestId: params.requestId })
        .then((body) => {
          if (body?.body && isActive()) {
            writer.write({
              body,
              kind: "Network.responseBody",
              requestId: params.requestId,
              source: "cdp",
              targetId: target.id,
            });
          }
        })
        .catch(() => {
          // Some responses are evicted before CDP can retrieve their bodies.
        });
    }
  });
  await client.connect();
  await Promise.all([
    client.send("Runtime.enable"),
    client.send("Network.enable", {
      maxPostDataSize: 10 * 1024 * 1024,
    }),
    client.send("Page.enable"),
  ]);
  await client.send("Runtime.addBinding", { name: "__codexVoiceTrace" });
  const expression = `(${rendererHook.toString()})(${JSON.stringify(hookConfiguration)})`;
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: expression,
  });
  const evaluation = await client.send("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
  if (!isActive()) {
    return client;
  }
  writer.write({
    evaluation,
    kind: "target-attached",
    source: "recorder",
    target: {
      id: target.id,
      title: target.title,
      type: target.type,
      url: target.url,
    },
  });
  if (startVoice && target.url === "app://-/index.html" && isActive()) {
    await client.send("Runtime.evaluate", {
      expression: `(() => {
        if (globalThis.__codexVoiceAutoStartScheduled) return;
        globalThis.__codexVoiceAutoStartScheduled = true;
        const timer = setInterval(() => {
          const button = [...document.querySelectorAll("button")].find(
            (candidate) => candidate.getAttribute("aria-label") === "Start new voice chat"
          );
          if (!button) return;
          clearInterval(timer);
          button.click();
          globalThis.__codexVoiceTrace(JSON.stringify({
            kind: "voice-auto-started",
            detail: {},
            pageTimestamp: new Date().toISOString(),
            performanceNow: performance.now(),
          }));
        }, 250);
      })()`,
    });
  }
  return client;
};

const run = async () => {
  const durationArgument = process.argv.find((argument) => argument.startsWith("--duration="));
  const durationSeconds = durationArgument
    ? Number(durationArgument.slice("--duration=".length))
    : undefined;
  if (
    durationSeconds !== undefined &&
    (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
  ) {
    throw new Error("--duration must be a positive number of seconds.");
  }

  const outputArgument = process.argv.find((argument) => argument.startsWith("--output="));
  const audioArgument = process.argv.find((argument) => argument.startsWith("--audio="));
  const audioPath = audioArgument ? resolvePath(audioArgument.slice("--audio=".length)) : undefined;
  const audioDelayArgument = process.argv.find((argument) => argument.startsWith("--audio-delay="));
  const syntheticDelayMs = audioDelayArgument
    ? Number(audioDelayArgument.slice("--audio-delay=".length))
    : 3000;
  if (!Number.isFinite(syntheticDelayMs) || syntheticDelayMs < 0 || syntheticDelayMs > 60_000) {
    throw new Error("--audio-delay must be between 0 and 60000 milliseconds.");
  }
  const startVoice = process.argv.includes("--start-voice");
  const hookConfiguration = {
    syntheticAudioBase64: audioPath ? readFileSync(audioPath).toString("base64") : undefined,
    syntheticDelayMs,
  };
  const runConfiguration = {
    audio: audioPath ? { path: audioPath, sha256: await hashFile(audioPath) } : null,
    startVoice,
    syntheticDelayMs,
  };
  const directory = outputArgument
    ? resolvePath(outputArgument.slice("--output=".length))
    : join(DEFAULT_CAPTURE_ROOT, `${timestampStem()}-codex`);
  mkdirSync(directory, { mode: 0o700, recursive: true });

  const port = await freePort();
  await writeManifest(directory, port, runConfiguration);
  const proxy = createProxyLauncher(directory);
  const writer = new NdjsonWriter(join(directory, "renderer.ndjson"));
  const mediaFiles = new Map();
  let stopping = false;
  let targetPoll;
  const targetRegistry = new TargetAttachmentRegistry(
    (target, isOwner) =>
      attachTarget(target, directory, writer, mediaFiles, hookConfiguration, startVoice, isOwner),
    (error, target) => {
      writer.write({
        error: error instanceof Error ? error.message : String(error),
        kind: "target-attach-error",
        source: "recorder",
        targetId: target.id,
      });
    },
  );

  const appStdout = createWriteStream(join(directory, "codex.stdout.log"), {
    mode: 0o600,
  });
  const appStderr = createWriteStream(join(directory, "codex.stderr.log"), {
    mode: 0o600,
  });
  const child = spawn(CODEX_EXECUTABLE, [`--remote-debugging-port=${port}`], {
    env: {
      ...process.env,
      CODEX_APP_SERVER_FORCE_CLI: "1",
      CODEX_CLI_PATH: proxy,
      CODEX_REAL_CLI_PATH: CODEX_CLI,
      CODEX_ROLLOUT_TRACE_ROOT: join(directory, "rollout-traces"),
      CODEX_VOICE_TRACE_DIR: directory,
      LOG_FORMAT: "json",
      RUST_LOG: "warn,codex_http_client::transport=trace,codex_api::realtime_websocket::wire=trace",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(appStdout);
  child.stderr.pipe(appStderr);

  const stop = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    if (targetPoll !== undefined) {
      clearInterval(targetPoll);
    }
    targetRegistry.stop();
    for (const output of mediaFiles.values()) {
      output.end();
    }
    writer.write({ kind: "recorder-stop", source: "recorder" });
    writer.close();
    child.kill("SIGTERM");
    setTimeout(() => {
      child.kill("SIGKILL");
      appStdout.end();
      appStderr.end();
      process.exit(0);
    }, 3000);
    process.stdout.write(`Capture complete: ${directory}\n`);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code, signal) => {
    if (stopping) {
      return;
    }
    writer.write({
      code,
      kind: "codex-exit",
      signal,
      source: "recorder",
    });
    stop();
  });

  const version = await waitForCdp(port);
  writer.write({ kind: "cdp-ready", source: "recorder", version });

  const pollTargets = async () => {
    let targets;
    try {
      targets = await getJson(`http://127.0.0.1:${port}/json/list`, CdpTargetsSchema);
    } catch (error) {
      if (!stopping) {
        writer.write({
          error: error instanceof Error ? error.message : String(error),
          kind: "target-poll-error",
          source: "recorder",
        });
      }
      return;
    }
    for (const target of targets) {
      if (target.type !== "page" || !target.webSocketDebuggerUrl) {
        continue;
      }
      targetRegistry.claim(target);
    }
  };
  await pollTargets();
  targetPoll = setInterval(() => {
    void pollTargets();
  }, TARGET_POLL_MS);

  process.stdout.write(
    [
      `Codex runtime recorder active.`,
      `Capture: ${directory}`,
      `CDP: http://127.0.0.1:${port}`,
      `Start a Codex voice session, then press Ctrl+C when finished.`,
      "",
    ].join("\n"),
  );

  if (durationSeconds !== undefined) {
    setTimeout(stop, durationSeconds * 1000);
  }
};

if (import.meta.main) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
