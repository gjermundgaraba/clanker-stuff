import { jsonText } from "@clanker-stuff/pi-tool-rendering/text";
import { structuralSchema } from "@clanker-stuff/pi-tool-schema";
import { StringEnum, type JsonValue, type TextContent } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
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

// Tools publish the structural shape so every provider's strict sampling subset
// can represent it; the runtime checks calls against the bounded schemas above.
export const startParameters = structuralSchema(startSchema);

export const inspectParameters = structuralSchema(inspectSchema);

export function toolResult<Details>(details: Details) {
  const text = jsonText(details);

  if (Buffer.byteLength(text) > MAX_TOOL_BYTES)
    throw new Error("Task response exceeds byte budget");

  return { content: [{ type: "text", text }] satisfies [TextContent], details };
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

export function payloadPage(data: JsonValue, offset = 0) {
  const bytes = Buffer.from(jsonText(data));

  const continuation = (index: number) =>
    index < bytes.length && (bytes.readUInt8(index) & 0xc0) === 0x80;

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
