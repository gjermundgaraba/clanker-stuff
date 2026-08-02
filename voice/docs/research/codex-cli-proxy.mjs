#!/usr/bin/env node

/* eslint-disable promise/prefer-await-to-callbacks, typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/strict-boolean-expressions */

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const { basename, join } = path;
const traceDirectory = process.env.CODEX_VOICE_TRACE_DIR;
const realCli =
  process.env.CODEX_REAL_CLI_PATH ??
  "/Applications/ChatGPT.app/Contents/Resources/codex";

if (!traceDirectory) {
  process.stderr.write("CODEX_VOICE_TRACE_DIR is required.\n");
  process.exit(64);
}

mkdirSync(traceDirectory, { mode: 0o700, recursive: true });

const processId = process.pid;
const stem = `app-server-${processId}`;
const inputBytes = createWriteStream(
  join(traceDirectory, `${stem}.stdin.bin`),
  {
    mode: 0o600,
  }
);
const outputBytes = createWriteStream(
  join(traceDirectory, `${stem}.stdout.bin`),
  { mode: 0o600 }
);
const errorBytes = createWriteStream(
  join(traceDirectory, `${stem}.stderr.bin`),
  {
    mode: 0o600,
  }
);
const events = createWriteStream(join(traceDirectory, `${stem}.rpc.ndjson`), {
  mode: 0o600,
});
let sequence = 0;

const record = (direction, line) => {
  sequence += 1;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    message = undefined;
  }
  events.write(
    `${JSON.stringify({
      direction,
      ...(message === undefined ? { line } : {}),
      message,
      monotonicNs: process.hrtime.bigint().toString(),
      sequence,
      timestamp: new Date().toISOString(),
    })}\n`
  );
};

const lineRecorder = (direction) => {
  let remainder = "";
  return {
    end() {
      if (remainder) {
        record(direction, remainder);
      }
    },
    push(chunk) {
      remainder += chunk.toString("utf-8");
      for (;;) {
        const newline = remainder.indexOf("\n");
        if (newline === -1) {
          return;
        }
        record(direction, remainder.slice(0, newline));
        remainder = remainder.slice(newline + 1);
      }
    },
  };
};

const inputLines = lineRecorder("renderer_to_app_server");
const outputLines = lineRecorder("app_server_to_renderer");
const errorLines = lineRecorder("app_server_stderr");

writeFileSync(
  join(traceDirectory, `${stem}.manifest.json`),
  `${JSON.stringify(
    {
      arguments: process.argv.slice(2),
      executable: realCli,
      proxy: import.meta.filename,
      proxyPid: processId,
      startedAt: new Date().toISOString(),
    },
    null,
    2
  )}\n`,
  { mode: 0o600 }
);

const environment = { ...process.env };
delete environment.CODEX_CLI_PATH;
const child = spawn(realCli, process.argv.slice(2), {
  env: environment,
  stdio: ["pipe", "pipe", "pipe"],
});
writeFileSync(
  join(traceDirectory, `${stem}.child.json`),
  `${JSON.stringify(
    {
      executable: realCli,
      pid: child.pid,
      startedAt: new Date().toISOString(),
    },
    null,
    2
  )}\n`,
  { mode: 0o600 }
);

const relay = (source, destination, byteLog, lines) => {
  source.on("data", (chunk) => {
    byteLog.write(chunk);
    lines.push(chunk);
    if (!destination.write(chunk)) {
      source.pause();
      destination.once("drain", () => source.resume());
    }
  });
  source.on("end", () => {
    lines.end();
    destination.end();
  });
};

relay(process.stdin, child.stdin, inputBytes, inputLines);
relay(child.stdout, process.stdout, outputBytes, outputLines);
relay(child.stderr, process.stderr, errorBytes, errorLines);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("error", (error) => {
  process.stderr.write(
    `Failed to start ${basename(realCli)}: ${error.message}\n`
  );
});

child.on("close", (code, signal) => {
  inputBytes.end();
  outputBytes.end();
  errorBytes.end();
  sequence += 1;
  events.end(
    `${JSON.stringify({
      code,
      direction: "proxy",
      event: "exit",
      monotonicNs: process.hrtime.bigint().toString(),
      sequence,
      signal,
      timestamp: new Date().toISOString(),
    })}\n`
  );
  process.exitCode = code ?? (signal ? 1 : 0);
});
