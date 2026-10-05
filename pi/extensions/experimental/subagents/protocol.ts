import { Type } from "typebox";
import type { Static } from "typebox";

import { ThinkingSchema } from "./config.js";

export const ROOT_AGENT_PATH = "/root";

export const SUBAGENT_MESSAGE_TYPE = "subagent-communication";

/** A rough character limit for task, message, and final-answer text, which sessions and the tree keep. */
export const MAX_DURABLE_TEXT = 256 * 1024;

/** A character limit for errors and the answers `list_agents` repeats; mail carries the full answer once. */
export const MAX_STATUS_TEXT = 1000;

const STRICT = { additionalProperties: false } as const;

const PATH_PATTERN = /^\/root(?:\/[a-z0-9_]+)*$/u;

const SEGMENT_PATTERN = /^[a-z0-9_]+$/u;

const AgentPathSchema = Type.String({ pattern: PATH_PATTERN.source });

const MailSchema = Type.Object(
  {
    content: Type.String(),
    from: AgentPathSchema,
    id: Type.String({ minLength: 1 }),
    kind: Type.Union([Type.Literal("MESSAGE"), Type.Literal("FINAL_ANSWER")]),
    to: AgentPathSchema,
  },
  STRICT,
);

const NodeSchema = Type.Object(
  {
    agentType: Type.Optional(Type.String({ minLength: 1 })),
    error: Type.Optional(Type.String()),
    lastAnswer: Type.Optional(Type.String()),
    model: Type.String({ minLength: 1 }),
    path: AgentPathSchema,
    sessionFile: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal("running"),
      Type.Literal("completed"),
      Type.Literal("errored"),
      Type.Literal("interrupted"),
    ]),
    thinking: ThinkingSchema,
    tools: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  },
  STRICT,
);

/** Persisted tree for one root session. Bump `version` on any shape change. */
export const TreeSchema = Type.Object(
  {
    nodes: Type.Array(NodeSchema),
    outbox: Type.Array(MailSchema),
    version: Type.Literal(3),
  },
  STRICT,
);

/** Identifies delivered mail in a transcript; other envelope details are display-only. */
export const MailDetailsSchema = Type.Object({ id: Type.String() });

export type Mail = Static<typeof MailSchema>;

export type AgentNode = Static<typeof NodeSchema>;

export type Tree = Static<typeof TreeSchema>;

export interface Envelope {
  content: string;
  from: string;
  kind: "FINAL_ANSWER" | "MESSAGE" | "NEW_TASK";
  to: string;
}

export type PublicAgentStatus =
  | "interrupted"
  | "not_found"
  | "running"
  | { completed: string | null }
  | { errored: string };

export const emptyTree = (): Tree => ({ nodes: [], outbox: [], version: 3 });

export const envelopeText = (envelope: Envelope): string =>
  `Message Type: ${envelope.kind}\nTask name: ${envelope.to}\nSender: ${envelope.from}\nPayload:\n${envelope.content}`;

export const mailMessage = (mail: Mail) => ({
  content: envelopeText(mail),
  customType: SUBAGENT_MESSAGE_TYPE,
  details: { from: mail.from, id: mail.id, kind: mail.kind, to: mail.to },
  display: false,
});

export const publicStatus = (node: AgentNode | undefined): PublicAgentStatus => {
  if (node === undefined) {
    return "not_found";
  }

  if (node.status === "completed") {
    return { completed: node.lastAnswer ?? null };
  }

  if (node.status === "errored") {
    return { errored: node.error ?? "Agent failed" };
  }

  return node.status;
};

const validatePath = (value: string): string => {
  if (!PATH_PATTERN.test(value)) {
    throw new Error(`Invalid agent path: ${value}`);
  }

  return value;
};

export const childAgentPath = (caller: string, taskName: string): string => {
  if (!SEGMENT_PATTERN.test(taskName)) {
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
