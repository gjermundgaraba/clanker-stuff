import { jsonText } from "@clanker-stuff/pi-tool-rendering/text";
import { structuralSchema } from "@clanker-stuff/pi-tool-schema";
import { StringEnum, type TextContent } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { DEFAULT_TAIL_BYTES, LOG_BYTES } from "./logs.js";
import type { ListRow, TaskSummary, ToolOutput } from "./output.js";

export const startSchema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: 80,
      description: "Short display label, up to 80 characters.",
    }),
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
    tailBytes: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: LOG_BYTES,
        description: `Log tail per stream in source bytes; default ${DEFAULT_TAIL_BYTES}.`,
      }),
    ),
  },
  { additionalProperties: false },
);

export type InspectInput = Static<typeof inspectSchema>;

export const idSchema = Type.Object({ id: Type.String() }, { additionalProperties: false });

export const listSchema = Type.Object({}, { additionalProperties: false });

/** Pi cuts its own tools' output at the same size. */
export const MAX_TEXT_BYTES = DEFAULT_MAX_BYTES;

// Tools publish the structural shape so every provider's strict sampling subset
// can represent it; the runtime checks calls against the bounded schemas above.
export const startParameters = structuralSchema(startSchema);

export const inspectParameters = structuralSchema(inspectSchema);

const PREVIEW_NOTE = `\n[Incomplete preview: the output exceeds ${MAX_TEXT_BYTES} bytes. task_inspect cuts only log tails, so a smaller tailBytes fits; Code Mode, where enabled, receives the complete structured value.]`;

/** Direct-model text is the JSON value, cut from the end when large; identity and status come first. */
export function toolResult<Details extends ToolOutput>(details: Details) {
  const json = Buffer.from(jsonText(details));
  let text = json.toString("utf8");

  if (json.length > MAX_TEXT_BYTES) {
    let end = MAX_TEXT_BYTES - Buffer.byteLength(PREVIEW_NOTE);

    // Cut on a UTF-8 character boundary.
    while (((json[end] ?? 0) & 0xc0) === 0x80) end--;
    text = json.subarray(0, end).toString("utf8") + PREVIEW_NOTE;
  }

  return {
    content: [{ type: "text", text }] satisfies [TextContent],
    details,
    structuredContent: details,
  };
}

export function taskRow(summary: TaskSummary, unread: boolean): ListRow {
  const { id, name, status, cleanup } = summary;

  return { id, name, status, cleanup, unread };
}
