import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { taskSummary } from "./supervisor.js";

export const startSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 80 }),
    command: Type.String({
      minLength: 1,
      maxLength: 4096,
      description:
        "Executable, not a shell command. Use args; for pipelines explicitly launch a shell.",
    }),
    args: Type.Optional(Type.Array(Type.String({ maxLength: 32768 }), { maxItems: 128 })),
    cwd: Type.Optional(Type.String({ maxLength: 4096 })),
    protocol: Type.Optional(
      StringEnum(["events-v1"] as const, {
        description:
          "Opt in to strict JSONL watcher records on stdout; stderr remains diagnostics.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 100,
        maximum: 86400000,
        description:
          "Task deadline; default one hour, maximum one day. All tasks also stop with the session.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type StartInput = Static<typeof startSchema>;
export const inspectSchema = Type.Object(
  {
    id: Type.String(),
    view: StringEnum(["summary", "result", "event"] as const),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "UTF-8 byte offset returned by payload.nextOffset; payload views only.",
      }),
    ),
    eventId: Type.Optional(Type.String()),
    tailBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })),
  },
  { additionalProperties: false },
);
export const idSchema = Type.Object({ id: Type.String() }, { additionalProperties: false });
export const listSchema = Type.Object({}, { additionalProperties: false });

export type InspectInput = Static<typeof inspectSchema>;
export const MAX_TOOL_BYTES = 32000;

export function prepareInspectArguments(args: unknown): InspectInput {
  // Persisted calls predate explicit views.
  if (typeof args === "object" && args !== null && !("view" in args)) {
    args = { ...args, view: "eventId" in args ? "event" : "summary" };
  }
  if (!Value.Check(inspectSchema, args)) throw new Error("Invalid task_inspect arguments");
  return args;
}

export function jsonText(data: unknown): string {
  // Escape display controls without changing the JSON value being retrieved.
  return JSON.stringify(data).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

export function toolResult(data: unknown) {
  const text = jsonText(data);
  if (Buffer.byteLength(text) > MAX_TOOL_BYTES)
    throw new Error("Task response exceeds byte budget");
  return { content: [{ type: "text" as const, text }], details: undefined };
}

export function taskRow(summary: ReturnType<typeof taskSummary>) {
  const { id, name, status, cleanup, abandoned } = summary;
  const characters = Array.from(name);
  return {
    id,
    name: characters.slice(0, 32).join("") + (characters.length > 32 ? "…" : ""),
    status,
    cleanup,
    abandoned,
  };
}

export function payloadPage(data: unknown, offset = 0) {
  const bytes = Buffer.from(jsonText(data));
  const continuation = (index: number) => index < bytes.length && (bytes[index] & 0xc0) === 0x80;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length || continuation(offset))
    throw new Error("Invalid payload offset; use the returned nextOffset");
  const page = (end: number) => ({
    encoding: "json" as const,
    offset,
    totalBytes: bytes.length,
    nextOffset: end < bytes.length ? end : null,
    text: bytes.subarray(offset, end).toString("utf8"),
  });
  const full = page(bytes.length);
  // Reserve 2 KiB for host metadata. Measure escaping in the actual response encoding.
  if (Buffer.byteLength(jsonText(full)) <= MAX_TOOL_BYTES - 2048) return full;
  let end = Math.min(bytes.length, offset + 12000);
  while (continuation(end)) end--;
  return page(end);
}
