#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const captureDirectory = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  throw new Error("Usage: extract-pi-capture.mjs <capture-directory>");
}

const evidenceDirectory = path.join(captureDirectory, "evidence");
mkdirSync(evidenceDirectory, { mode: 0o700, recursive: true });

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

let callRequest;
let callResponse;
const mediaEvents = [];
const sideband = [];
const mediaFiles = new Map();
await readNdjson(path.join(captureDirectory, "voice.ndjson"), (envelope) => {
  if (envelope.kind === "realtime.call.request") {
    callRequest = envelope;
  } else if (envelope.kind === "realtime.call.response") {
    callResponse = envelope;
  } else if (envelope.kind === "realtime.sideband.received") {
    sideband.push({
      direction: "received",
      event: JSON.parse(envelope.detail.data),
      timestamp: envelope.timestamp,
    });
  } else if (envelope.kind === "realtime.sideband.sent") {
    sideband.push({
      direction: "sent",
      event: JSON.parse(envelope.detail.data),
      timestamp: envelope.timestamp,
    });
  } else if (envelope.kind.startsWith("media.")) {
    const message =
      envelope.kind === "media.received"
        ? JSON.parse(envelope.detail.line)
        : undefined;
    if (
      message?.event === "trace" &&
      message.kind === "media-chunk" &&
      typeof message.data?.data === "string"
    ) {
      const { capturePoint, data } = message.data;
      let file = mediaFiles.get(capturePoint);
      if (!file) {
        file = path.join(evidenceDirectory, `${capturePoint}.webm`);
        writeFileSync(file, "", { mode: 0o600 });
        mediaFiles.set(capturePoint, file);
      }
      appendFileSync(file, Buffer.from(data, "base64"));
    } else {
      mediaEvents.push(envelope);
    }
  }
});

if (!callRequest) {
  throw new Error("Capture did not contain a realtime call request.");
}

const piEvents = [];
await readNdjson(path.join(captureDirectory, "pi.ndjson"), (event) => {
  piEvents.push(event);
});

const turns = sideband
  .filter(({ event }) => event.type === "turn.done")
  .map(({ event, timestamp }) => ({ timestamp, ...event.turn }));
const handoffs = sideband
  .filter(({ event }) => event.type === "delegation.created")
  .map(({ event, timestamp }) => ({ timestamp, ...event.item }));

writeJson("realtime-call-request.json", callRequest.detail);
if (callResponse) {
  writeJson("realtime-call-response.json", callResponse.detail);
}
writeJson("realtime-session-request.json", callRequest.detail.body.session);
writeFileSync(
  path.join(evidenceDirectory, "realtime-prompt.md"),
  `${callRequest.detail.body.session.instructions}\n`,
  { mode: 0o600 }
);
writeNdjson("native-sideband.ndjson", sideband);
writeNdjson("media-events.ndjson", mediaEvents);
writeNdjson("pi-events.ndjson", piEvents);
writeJson("observed-conversation.json", { handoffs, turns });
writeJson(
  "provider-requests.json",
  piEvents
    .filter(({ kind }) => kind === "before_provider_request")
    .map(({ detail, timestamp }) => ({ detail, timestamp }))
);

const sha256 = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
};

const evidenceHashes = [];
for (const name of readdirSync(evidenceDirectory)
  .filter((candidate) => candidate !== "SHA256SUMS")
  .toSorted()) {
  evidenceHashes.push(
    `${await sha256(path.join(evidenceDirectory, name))}  ${name}`
  );
}
writeFileSync(
  path.join(evidenceDirectory, "SHA256SUMS"),
  `${evidenceHashes.join("\n")}\n`,
  { mode: 0o600 }
);

process.stdout.write(
  `${JSON.stringify(
    {
      evidenceDirectory,
      handoffs: handoffs.length,
      piEvents: piEvents.length,
      sidebandFrames: sideband.length,
      turns: turns.length,
    },
    null,
    2
  )}\n`
);
