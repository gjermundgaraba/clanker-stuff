#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import { createEvidenceSnapshot } from "./evidence-snapshot.mjs";

const captureDirectory = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  throw new Error("Usage: extract-codex-capture.mjs <capture-directory>");
}

const evidenceSnapshot = createEvidenceSnapshot(captureDirectory);
const evidenceDirectory = evidenceSnapshot.directory;
let published = false;

const writeJson = (name, value) => {
  writeFileSync(
    path.join(evidenceDirectory, name),
    `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600 }
  );
};

const writeNdjson = (name, values) => {
  writeFileSync(
    path.join(evidenceDirectory, name),
    `${values.map((value) => JSON.stringify(value)).join("\n")}\n`,
    { mode: 0o600 }
  );
};

const readNdjson = async (file, visit) => {
  const lines = createInterface({ input: createReadStream(file) });
  for await (const line of lines) {
    if (line) {
      visit(JSON.parse(line));
    }
  }
};

try {
  const files = readdirSync(captureDirectory)
    .filter((name) => statSync(path.join(captureDirectory, name)).isFile())
    .toSorted();
  const rpcFile = files.find((name) =>
    /^app-server-\d+\.rpc\.ndjson$/u.test(name)
  );
  const stderrFile = files.find((name) =>
    /^app-server-\d+\.stderr\.bin$/u.test(name)
  );
  if (!rpcFile || !stderrFile) {
    throw new Error("Capture is missing app-server RPC or stderr evidence.");
  }

  const appServerEvents = [];
  let realtimeStart;
  let threadStart;
  await readNdjson(path.join(captureDirectory, rpcFile), (envelope) => {
    const { message } = envelope;
    if (!message || typeof message !== "object") {
      return;
    }
    if (message.method === "thread/realtime/start") {
      realtimeStart = envelope;
    }
    if (message.method === "thread/start") {
      threadStart = envelope;
    }
    if (
      message.method?.startsWith("thread/realtime/") ||
      [
        "item/completed",
        "item/started",
        "turn/completed",
        "turn/started",
      ].includes(message.method)
    ) {
      appServerEvents.push(envelope);
    }
  });

  const rendererEvents = [];
  let sessionStarted;
  let lastRendererTimestamp;
  await readNdjson(
    path.join(captureDirectory, "renderer.ndjson"),
    (envelope) => {
      lastRendererTimestamp = envelope.timestamp;
      if (
        [
          "data-channel-received",
          "data-channel-sent",
          "get-user-media-request",
          "get-user-media-result",
          "media-recorder-start",
          "peer-add-track",
          "peer-connection-state",
          "peer-created",
          "peer-track",
          "synthetic-audio-scheduled",
          "voice-auto-started",
        ].includes(envelope.kind)
      ) {
        rendererEvents.push(envelope);
      }
      if (
        envelope.kind === "data-channel-received" &&
        typeof envelope.detail?.data === "string"
      ) {
        const data = JSON.parse(envelope.detail.data);
        if (data.type === "session.started") {
          sessionStarted = data;
        }
      }
    }
  );

  let callRequest;
  const sideband = [];
  await readNdjson(path.join(captureDirectory, stderrFile), (envelope) => {
    const message = envelope.fields?.message;
    if (typeof message !== "string") {
      return;
    }
    const callMarker =
      "POST to https://chatgpt.com/backend-api/codex/realtime/calls";
    if (message.startsWith(callMarker)) {
      callRequest = JSON.parse(message.slice(message.indexOf(": ") + 2));
      return;
    }
    for (const [direction, prefix] of [
      ["sent", "realtime websocket request: "],
      ["received", "realtime websocket event: "],
    ]) {
      if (message.startsWith(prefix)) {
        sideband.push({
          direction,
          event: JSON.parse(message.slice(prefix.length)),
          timestamp: envelope.timestamp,
        });
      }
    }
  });

  const turns = sideband
    .filter(({ event }) => event.type === "turn.done")
    .map(({ event, timestamp }) => ({ timestamp, ...event.turn }));
  const handoffs = sideband
    .filter(({ event }) => event.type === "delegation.created")
    .map(({ event, timestamp }) => ({ timestamp, ...event.item }));
  const contextAppends = sideband
    .filter(({ event }) => event.type.endsWith(".context.append"))
    .map(({ event, timestamp }) => ({ timestamp, ...event }));

  if (callRequest) {
    writeJson("native-realtime-call-request.json", callRequest);
    writeJson("realtime-session-request.json", callRequest.session);
    writeFileSync(
      path.join(evidenceDirectory, "realtime-prompt.md"),
      `${callRequest.session.instructions}\n`,
      { mode: 0o600 }
    );
  }
  if (sessionStarted) {
    writeJson("realtime-session-started.json", sessionStarted);
  }
  if (realtimeStart) {
    writeJson("app-server-realtime-start.json", realtimeStart);
  }
  if (threadStart) {
    writeJson("coordinator-thread-start.json", threadStart);
  }
  writeNdjson("native-sideband.ndjson", sideband);
  writeNdjson("app-server-events.ndjson", appServerEvents);
  writeNdjson("renderer-media-events.ndjson", rendererEvents);
  writeJson("observed-conversation.json", {
    contextAppends,
    handoffs,
    turns,
  });

  let nativeLogExport;
  const childFile = files.find((name) =>
    /^app-server-\d+\.child\.json$/u.test(name)
  );
  const manifestFile = path.join(captureDirectory, "manifest.json");
  const nativeLogDatabase = path.join(
    process.env.HOME,
    ".codex",
    "logs_2.sqlite"
  );
  if (childFile && existsSync(manifestFile) && existsSync(nativeLogDatabase)) {
    const child = JSON.parse(
      readFileSync(path.join(captureDirectory, childFile), "utf-8")
    );
    const manifest = JSON.parse(readFileSync(manifestFile, "utf-8"));
    const startedAtSeconds = Math.floor(Date.parse(manifest.startedAt) / 1000);
    const endedAtSeconds = Math.ceil(
      Date.parse(lastRendererTimestamp ?? new Date().toISOString()) / 1000
    );
    if (
      Number.isInteger(child.pid) &&
      Number.isFinite(startedAtSeconds) &&
      Number.isFinite(endedAtSeconds)
    ) {
      const query = `
      SELECT id, ts, ts_nanos, level, target, file, line, thread_id,
             process_uuid, feedback_log_body
      FROM logs INDEXED BY idx_logs_ts
      WHERE ts BETWEEN ${startedAtSeconds - 1} AND ${endedAtSeconds + 1}
        AND process_uuid LIKE 'pid:${child.pid}:%'
        AND target IN (
          'codex_http_client::transport',
          'codex_api::realtime_websocket::wire'
        )
      ORDER BY ts, ts_nanos, id;
    `;
      const result = spawnSync(
        "sqlite3",
        ["-readonly", "-json", nativeLogDatabase, query],
        { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 }
      );
      if (result.status === 0) {
        const events = result.stdout.trim() ? JSON.parse(result.stdout) : [];
        writeJson("native-sqlite-events.json", events);
        nativeLogExport = { events: events.length, source: nativeLogDatabase };
      } else {
        nativeLogExport = {
          error: result.stderr.trim() || `sqlite3 exited ${result.status}`,
          source: nativeLogDatabase,
        };
      }
    }
  }

  const missing = [
    ["app-server realtime start", realtimeStart],
    ["native realtime call request", callRequest],
    ["realtime session.started", sessionStarted],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  const valid = missing.length === 0;
  writeJson("capture-status.json", { missing, nativeLogExport, valid });

  const threadId =
    realtimeStart?.message?.params?.threadId ??
    threadStart?.message?.params?.threadId;
  const sessionRoot = path.join(process.env.HOME, ".codex", "sessions");
  const rollout = threadId
    ? readdirSync(sessionRoot, { recursive: true })
        .map(String)
        .find((name) => name.endsWith(`${threadId}.jsonl`))
    : undefined;
  if (rollout) {
    const source = path.join(sessionRoot, rollout);
    const target = path.join(evidenceDirectory, "coordinator-rollout.jsonl");
    copyFileSync(source, target);
    chmodSync(target, 0o600);
  }

  const rolloutTraceRoot = path.join(captureDirectory, "rollout-traces");
  if (threadId && existsSync(rolloutTraceRoot)) {
    const traceDirectory = readdirSync(rolloutTraceRoot, {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .find((name) => name.endsWith(`-${threadId}`));
    if (traceDirectory) {
      const target = path.join(evidenceDirectory, "coordinator-trace");
      cpSync(path.join(rolloutTraceRoot, traceDirectory), target, {
        force: true,
        recursive: true,
      });
      chmodSync(target, 0o700);
      for (const name of readdirSync(target, { recursive: true })) {
        const candidate = path.join(target, String(name));
        chmodSync(candidate, statSync(candidate).isDirectory() ? 0o700 : 0o600);
      }
    }
  }

  const sha256 = async (file) => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) {
      hash.update(chunk);
    }
    return hash.digest("hex");
  };

  const evidenceFiles = readdirSync(evidenceDirectory, { recursive: true })
    .map(String)
    .filter(
      (name) =>
        statSync(path.join(evidenceDirectory, name)).isFile() &&
        name !== "RAW_SHA256SUMS" &&
        name !== "SHA256SUMS"
    )
    .toSorted();
  const evidenceHashes = [];
  for (const name of evidenceFiles) {
    evidenceHashes.push(
      `${await sha256(path.join(evidenceDirectory, name))}  ${name}`
    );
  }
  writeFileSync(
    path.join(evidenceDirectory, "SHA256SUMS"),
    `${evidenceHashes.join("\n")}\n`,
    { mode: 0o600 }
  );

  const rawHashes = [];
  for (const name of files) {
    rawHashes.push(
      `${await sha256(path.join(captureDirectory, name))}  ${name}`
    );
  }
  writeFileSync(
    path.join(evidenceDirectory, "RAW_SHA256SUMS"),
    `${rawHashes.join("\n")}\n`,
    { mode: 0o600 }
  );

  evidenceSnapshot.publish();
  published = true;
  process.stdout.write(
    `${JSON.stringify(
      {
        appServerEvents: appServerEvents.length,
        evidenceDirectory: evidenceSnapshot.evidenceDirectory,
        handoffs: handoffs.length,
        missing,
        sidebandFrames: sideband.length,
        turns: turns.length,
        valid,
      },
      null,
      2
    )}\n`
  );
} finally {
  if (!published) {
    evidenceSnapshot.discard();
  }
}
