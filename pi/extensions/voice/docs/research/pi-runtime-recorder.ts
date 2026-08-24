import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const directory = process.env.PI_VOICE_TRACE_DIR;
const BigIntSchema = Type.BigInt();

type Recorder = <T>(kind: string, detail: T) => void;

const recorder: Recorder | undefined =
  directory !== undefined && directory.length > 0
    ? (() => {
        mkdirSync(directory, { mode: 0o700, recursive: true });
        const file = path.join(directory, "pi.ndjson");
        let sequence = 0;
        return <T>(kind: string, detail: T): void => {
          sequence += 1;
          appendFileSync(
            file,
            `${JSON.stringify(
              {
                detail,
                kind,
                monotonicNs: process.hrtime.bigint().toString(),
                sequence,
                timestamp: new Date().toISOString(),
              },
              (_key, value) => (Value.Check(BigIntSchema, value) ? value.toString() : value),
            )}\n`,
            { encoding: "utf-8", mode: 0o600 },
          );
        };
      })()
    : undefined;

const redactHeaders = (headers: Record<string, string | null>) =>
  Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      /authorization|api[-_]key|cookie|token/iu.test(key) ? "[REDACTED]" : value,
    ]),
  );

export default function piRuntimeRecorder(pi: ExtensionAPI): void {
  const record = <T>(kind: string, detail: T): void => {
    recorder?.(kind, detail);
  };

  pi.on("session_start", (event, ctx) => {
    record(event.type, {
      branch: ctx.sessionManager.getBranch(),
      cwd: ctx.cwd,
      model: ctx.model,
      sessionFile: ctx.sessionManager.getSessionFile(),
      sessionId: ctx.sessionManager.getSessionId(),
      thinkingLevel: ctx.thinkingLevel,
    });
  });
  pi.on("input", (event) => {
    record(event.type, event);
  });
  pi.on("before_agent_start", (event) => {
    record(event.type, event);
  });
  pi.on("context", (event) => {
    record(event.type, event);
  });
  pi.on("before_provider_headers", (event) => {
    record(event.type, { headers: redactHeaders(event.headers) });
  });
  pi.on("before_provider_request", (event) => {
    record(event.type, event);
  });
  pi.on("after_provider_response", (event) => {
    record(event.type, event);
  });
  pi.on("agent_start", (event) => {
    record(event.type, event);
  });
  pi.on("agent_end", (event) => {
    record(event.type, event);
  });
  pi.on("agent_settled", (event) => {
    record(event.type, event);
  });
  pi.on("turn_start", (event) => {
    record(event.type, event);
  });
  pi.on("turn_end", (event) => {
    record(event.type, event);
  });
  pi.on("message_start", (event) => {
    record(event.type, event);
  });
  pi.on("message_update", (event) => {
    record(event.type, event);
  });
  pi.on("message_end", (event) => {
    record(event.type, event);
  });
  pi.on("tool_call", (event) => {
    record(event.type, event);
  });
  pi.on("tool_result", (event) => {
    record(event.type, event);
  });
  pi.on("tool_execution_start", (event) => {
    record(event.type, event);
  });
  pi.on("tool_execution_update", (event) => {
    record(event.type, event);
  });
  pi.on("tool_execution_end", (event) => {
    record(event.type, event);
  });
  pi.on("session_shutdown", (event, ctx) => {
    record(event.type, {
      branch: ctx.sessionManager.getBranch(),
      event,
    });
  });
}
