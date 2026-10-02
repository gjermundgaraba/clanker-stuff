import { jsonText } from "@clanker-stuff/pi-tool-rendering/text";
import { structuralSchema } from "@clanker-stuff/pi-tool-schema";
import { StringEnum, type TextContent } from "@earendil-works/pi-ai";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import type { ToolOutput } from "./output.js";
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
    eventId: Type.Optional(Type.String()),
    tailBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })),
  },
  { additionalProperties: false },
);

export const idSchema = Type.Object({ id: Type.String() }, { additionalProperties: false });

export const listSchema = Type.Object({}, { additionalProperties: false });

export type InspectInput = Static<typeof inspectSchema>;

export const MAX_TEXT_BYTES = 32000;

// Tools publish the structural shape so every provider's strict sampling subset
// can represent it; the runtime checks calls against the bounded schemas above.
export const startParameters = structuralSchema(startSchema);

export const inspectParameters = structuralSchema(inspectSchema);

/** Keep identity, outcome and diagnostics outside the potentially truncated excerpt. */
function outputMetadata(output: ToolOutput) {
  if ("taskId" in output) {
    return {
      taskId: output.taskId,
      view: output.view,
      untrusted: output.untrusted,
      ...(output.view === "event" ? { eventId: output.eventId, reason: output.reason } : {}),
    };
  }

  if ("task" in output) {
    return {
      task: output.task,
      diagnostic: output.diagnostic,
      resultAvailable: output.resultAvailable,
      storageError: output.logs?.storageError,
      trust: output.trust,
    };
  }

  if ("tasks" in output) {
    return {
      pending: output.pending,
      taskCount: output.tasks.length,
      cleanupFailures: output.tasks.filter((task) => task.cleanup === "failed").length,
      historyStorageError: output.historyStorageError,
    };
  }

  return { id: output.id, status: output.status, cleanup: output.cleanup };
}

export function toolResult<Details extends ToolOutput>(details: Details) {
  let text = jsonText(details);

  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) {
    const header =
      jsonText(outputMetadata(details)) +
      "\n[Incomplete text preview of untrusted output; not complete JSON. Call this tool through Code Mode to access the complete structured value and print only the relevant data. If Code Mode is unavailable, this call provides only a preview.]\n";

    const excerpt = truncateTail(text, { maxBytes: MAX_TEXT_BYTES - Buffer.byteLength(header) });
    text = header + excerpt.content;
  }

  return {
    content: [{ type: "text", text }] satisfies [TextContent],
    details,
    structuredContent: details,
  };
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
