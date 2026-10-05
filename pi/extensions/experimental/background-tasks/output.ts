import { StringEnum, type JsonValue } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

const strict = { additionalProperties: false } as const;

export const taskSummarySchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    pid: Type.Optional(Type.Integer()),
    status: StringEnum([
      "running",
      "completed",
      "result",
      "result_missing",
      "process_error",
      "spawn_error",
      "protocol_error",
      "timeout",
      "cancelled",
    ] as const),
    cleanup: StringEnum(["pending", "clean", "failed"] as const),
    startedAt: Type.Number(),
    endedAt: Type.Optional(Type.Number()),
    exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    signal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  strict,
);

export type TaskSummary = Static<typeof taskSummarySchema>;

export type Outcome = Exclude<TaskSummary["status"], "running">;

export const logsSchema = Type.Object(
  {
    stdout: Type.String(),
    stderr: Type.String(),
    stdoutOmittedBytes: Type.Integer(),
    stderrOmittedBytes: Type.Integer(),
  },
  strict,
);

export type LogSummary = Static<typeof logsSchema>;

// Watcher data was decoded from JSON at capture; its application-specific shape is opaque.
const dataSchema = Type.Unsafe<JsonValue>(Type.Unknown());

const { id, name, status, cleanup } = taskSummarySchema.properties;

export const listRowSchema = Type.Object(
  { id, name, status, cleanup, unread: Type.Boolean() },
  strict,
);

export type ListRow = Static<typeof listRowSchema>;

export const listOutputSchema = Type.Object({ tasks: Type.Array(listRowSchema) }, strict);

const eventSchema = Type.Object(
  { seq: Type.Integer(), key: Type.Optional(Type.String()), data: dataSchema },
  strict,
);

export type TaskEvent = Static<typeof eventSchema>;

export const inspectOutputSchema = Type.Object(
  {
    task: taskSummarySchema,
    diagnostic: Type.Optional(Type.String()),
    result: Type.Optional(dataSchema),
    events: Type.Array(eventSchema),
    omittedEvents: Type.Integer(),
    logs: logsSchema,
  },
  strict,
);

export type InspectOutput = Static<typeof inspectOutputSchema>;

export const toolOutputSchema = Type.Union([
  taskSummarySchema,
  listOutputSchema,
  inspectOutputSchema,
]);

export type ToolOutput = Static<typeof toolOutputSchema>;
