import { Type } from "typebox";
import type { Static } from "typebox";

export const ROOT_AGENT_PATH = "/root";
export const SUBAGENT_MESSAGE_TYPE = "subagent-communication";
export const V2_TOOL_NAMES = [
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
] as const;
const PATH_PATTERN = /^\/root(?:\/[a-z0-9_]+)*$/u;

const AgentPathSchema = Type.String({ pattern: PATH_PATTERN.source });
const CommunicationCommon = {
  content: Type.String(),
  from: AgentPathSchema,
  id: Type.String({ minLength: 1 }),
  to: AgentPathSchema,
};
const CommunicationSchema = Type.Union([
  Type.Object(
    {
      ...CommunicationCommon,
      delivery: Type.Union([Type.Literal("queue"), Type.Literal("turn")]),
      kind: Type.Literal("NEW_TASK"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...CommunicationCommon,
      delivery: Type.Literal("queue"),
      kind: Type.Union([Type.Literal("MESSAGE"), Type.Literal("FINAL_ANSWER")]),
    },
    { additionalProperties: false },
  ),
]);
const PersistedAgentCommon = {
  agentType: Type.Optional(Type.String({ minLength: 1 })),
  lastAnswer: Type.Optional(Type.String()),
  nickname: Type.String({ minLength: 1 }),
  path: AgentPathSchema,
  sessionFile: Type.String({ minLength: 1 }),
  tools: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
};
const PersistedAgentSchema = Type.Union([
  Type.Object(
    {
      ...PersistedAgentCommon,
      activeDeliveryId: Type.String({ minLength: 1 }),
      error: Type.Optional(Type.Never()),
      status: Type.Union([Type.Literal("pending"), Type.Literal("running")]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...PersistedAgentCommon,
      activeDeliveryId: Type.Optional(Type.Never()),
      error: Type.Optional(Type.Never()),
      status: Type.Union([Type.Literal("completed"), Type.Literal("interrupted")]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...PersistedAgentCommon,
      activeDeliveryId: Type.Optional(Type.Never()),
      error: Type.String(),
      status: Type.Literal("errored"),
    },
    { additionalProperties: false },
  ),
]);
export const V2SnapshotSchema = Type.Object(
  {
    communications: Type.Array(CommunicationSchema),
    nodes: Type.Array(PersistedAgentSchema),
  },
  { additionalProperties: false },
);

export type AgentStatus = PersistedAgent["status"];
export type Communication = Static<typeof CommunicationSchema>;
export type PersistedAgent = Static<typeof PersistedAgentSchema>;
export type V2Snapshot = Static<typeof V2SnapshotSchema>;
const SEGMENT_PATTERN = /^[a-z0-9_]+$/u;

export const communicationEnvelope = (message: Communication): string =>
  `Message Type: ${message.kind}\nTask name: ${message.to}\nSender: ${message.from}\nPayload:\n${message.content}`;

export const isAgentPath = (value: string): boolean => PATH_PATTERN.test(value);

const validatePath = (value: string): string => {
  if (!PATH_PATTERN.test(value)) {
    throw new Error(`Invalid agent path: ${value}`);
  }
  return value;
};

export const childAgentPath = (caller: string, taskName: string): string => {
  if (taskName.trim() !== taskName || taskName.at(-1) === "\n" || !SEGMENT_PATTERN.test(taskName)) {
    throw new Error("task_name must contain only lowercase letters, digits, and underscores");
  }
  if (taskName === "root") {
    throw new Error("task_name root is reserved");
  }
  return validatePath(`${caller}/${taskName}`);
};

export const resolveAgentPath = (caller: string, target: string): string => {
  if (target === "") {
    throw new Error("Agent target must not be blank");
  }
  return validatePath(target.startsWith("/") ? target : `${caller}/${target}`);
};

export const parentAgentPath = (path: string): string | undefined =>
  path === ROOT_AGENT_PATH ? undefined : path.slice(0, path.lastIndexOf("/"));
