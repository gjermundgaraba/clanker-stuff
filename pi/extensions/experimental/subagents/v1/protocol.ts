import { Type } from "typebox";
import type { Static } from "typebox";

export const V1_TOOL_NAMES = [
  "spawn_agent",
  "send_input",
  "resume_agent",
  "wait_agent",
  "close_agent",
] as const;

const StatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("interrupted"),
  Type.Literal("completed"),
  Type.Literal("errored"),
  Type.Literal("shutdown"),
]);
const PromptInputSchema = Type.Object(
  {
    images: Type.Optional(
      Type.Array(
        Type.Object(
          {
            data: Type.String(),
            mimeType: Type.String({ minLength: 1 }),
            type: Type.Literal("image"),
          },
          { additionalProperties: false }
        )
      )
    ),
    text: Type.String(),
  },
  { additionalProperties: false }
);
const TurnSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    input: PromptInputSchema,
  },
  { additionalProperties: false }
);
const ActiveTurnProperties = {
  ...TurnSchema.properties,
};
const PendingTurnSchema = Type.Object(
  {
    ...ActiveTurnProperties,
    phase: Type.Literal("pending"),
  },
  { additionalProperties: false }
);
const RunningTurnSchema = Type.Object(
  {
    ...ActiveTurnProperties,
    phase: Type.Literal("running"),
  },
  { additionalProperties: false }
);
const NotificationSchema = Type.Object(
  {
    agentId: Type.String({ minLength: 1 }),
    content: Type.String(),
    id: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
const AgentIdentityProperties = {
  id: Type.String({ minLength: 1 }),
  nickname: Type.String({ minLength: 1 }),
  role: Type.Optional(Type.String({ minLength: 1 })),
  sessionFile: Type.String({ minLength: 1 }),
  tools: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
};
const OpenAgentProperties = {
  ...AgentIdentityProperties,
  edge: Type.Literal("open"),
  lastAnswer: Type.Optional(Type.String()),
  queue: Type.Array(TurnSchema),
};
const AgentSchema = Type.Union([
  Type.Object(
    {
      ...OpenAgentProperties,
      active: PendingTurnSchema,
      error: Type.Optional(Type.Never()),
      status: Type.Literal("pending"),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...OpenAgentProperties,
      active: RunningTurnSchema,
      error: Type.Optional(Type.Never()),
      status: Type.Literal("running"),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...OpenAgentProperties,
      active: Type.Optional(Type.Never()),
      error: Type.Optional(Type.Never()),
      status: Type.Literal("interrupted"),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...OpenAgentProperties,
      active: Type.Optional(Type.Never()),
      error: Type.Optional(Type.Never()),
      status: Type.Literal("completed"),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...OpenAgentProperties,
      active: Type.Optional(Type.Never()),
      error: Type.String(),
      status: Type.Literal("errored"),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...AgentIdentityProperties,
      active: Type.Optional(Type.Never()),
      edge: Type.Literal("closed"),
      error: Type.Optional(Type.Never()),
      lastAnswer: Type.Optional(Type.String()),
      queue: Type.Tuple([]),
      status: Type.Literal("shutdown"),
    },
    { additionalProperties: false }
  ),
]);
export const V1SnapshotSchema = Type.Object(
  {
    agents: Type.Array(AgentSchema),
    notifications: Type.Array(NotificationSchema),
  },
  { additionalProperties: false }
);

export type V1AgentStatus = Static<typeof StatusSchema>;
export type V1Notification = Static<typeof NotificationSchema>;
export type V1PersistedAgent = Static<typeof AgentSchema>;
export type V1Snapshot = Static<typeof V1SnapshotSchema>;
export type V1Turn = Static<typeof TurnSchema>;

export const isFinalStatus = (status: V1AgentStatus): boolean =>
  status === "completed" || status === "errored" || status === "shutdown";
