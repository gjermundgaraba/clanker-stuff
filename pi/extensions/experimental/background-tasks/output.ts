import { StringEnum, type JsonValue } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

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
    abandoned: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type TaskSummary = Static<typeof taskSummarySchema>;

export const logsSchema = Type.Object(
  {
    stdout: Type.String(),
    stderr: Type.String(),
    stdoutOmittedBytes: Type.Integer(),
    stderrOmittedBytes: Type.Integer(),
    directory: Type.String(),
    storageError: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type LogSummary = Static<typeof logsSchema>;

// Watcher data was decoded from JSON at capture; its application-specific shape is opaque.
const dataSchema = Type.Unsafe<JsonValue>(Type.Unknown());

export const startOutputSchema = Type.Object(
  { ...taskSummarySchema.properties, note: Type.String() },
  { additionalProperties: false },
);

export type StartOutput = Static<typeof startOutputSchema>;

export const listOutputSchema = Type.Object(
  {
    pending: Type.Integer(),
    tasks: Type.Array(
      Type.Pick(taskSummarySchema, ["id", "name", "status", "cleanup", "abandoned"]),
    ),
    omittedProgress: Type.Integer(),
    evictedEvents: Type.Integer(),
    evictedTasks: Type.Integer(),
    historyStorageError: Type.Optional(Type.String()),
    lifetime: Type.String(),
  },
  { additionalProperties: false },
);

export type ListOutput = Static<typeof listOutputSchema>;

export const inspectOutputSchema = Type.Union([
  Type.Object(
    {
      task: taskSummarySchema,
      diagnostic: Type.Optional(Type.String()),
      resultAvailable: Type.Boolean(),
      events: Type.Array(
        Type.Object(
          { id: Type.String(), seq: Type.Integer(), reason: Type.String() },
          { additionalProperties: false },
        ),
      ),
      logs: Type.Optional(logsSchema),
      trust: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      taskId: Type.String(),
      view: Type.Literal("event"),
      eventId: Type.String(),
      untrusted: Type.Literal(true),
      reason: Type.String(),
      data: Type.Optional(dataSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      taskId: Type.String(),
      view: Type.Literal("result"),
      untrusted: Type.Literal(true),
      data: dataSchema,
    },
    { additionalProperties: false },
  ),
]);

export type InspectOutput = Static<typeof inspectOutputSchema>;

export const toolOutputSchema = Type.Union([
  startOutputSchema,
  listOutputSchema,
  inspectOutputSchema,
  taskSummarySchema,
]);

export type ToolOutput = Static<typeof toolOutputSchema>;
