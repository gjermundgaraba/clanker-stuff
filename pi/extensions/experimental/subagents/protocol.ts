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
    /** Set on the final answer of a failed turn, for presentation; the content says so to the model. */
    failed: Type.Optional(Type.Literal(true)),
    from: AgentPathSchema,
    id: Type.String({ minLength: 1 }),
    kind: Type.Union([Type.Literal("MESSAGE"), Type.Literal("FINAL_ANSWER")]),
    to: AgentPathSchema,
  },
  STRICT
);

const TimestampSchema = Type.Integer({ minimum: 0 });

const AmountSchema = Type.Number({ minimum: 0 });

/** Usage summed over every assistant response of the agent, across all its turns. */
const UsageSchema = Type.Object(
  {
    cacheRead: AmountSchema,
    cacheWrite: AmountSchema,
    cost: AmountSchema,
    input: AmountSchema,
    output: AmountSchema,
  },
  STRICT
);

const NodeSchema = Type.Object(
  {
    agentType: Type.Optional(Type.String({ minLength: 1 })),
    /** When the latest turn settled; absent while it runs, or when it was cut short by a restart. */
    endedAt: Type.Optional(TimestampSchema),
    error: Type.Optional(Type.String()),
    lastAnswer: Type.Optional(Type.String()),
    model: Type.String({ minLength: 1 }),
    path: AgentPathSchema,
    sessionFile: Type.String({ minLength: 1 }),
    /** When the latest turn started. */
    startedAt: TimestampSchema,
    status: Type.Union([
      Type.Literal("running"),
      Type.Literal("completed"),
      Type.Literal("errored"),
      Type.Literal("interrupted"),
    ]),
    thinking: ThinkingSchema,
    tools: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    usage: UsageSchema,
  },
  STRICT
);

/** Persisted tree for one root session. Bump `version` on any shape change. */
export const TreeSchema = Type.Object(
  {
    nodes: Type.Array(NodeSchema),
    outbox: Type.Array(MailSchema),
    version: Type.Literal(4),
  },
  STRICT
);

/** Identifies delivered mail in a transcript; the outcome and other details are display-only. */
export const MailDetailsSchema = Type.Object({
  failed: Type.Optional(Type.Literal(true)),
  id: Type.String(),
});

export type Mail = Static<typeof MailSchema>;

export type AgentNode = Static<typeof NodeSchema>;

export type AgentUsage = Static<typeof UsageSchema>;

export type Tree = Static<typeof TreeSchema>;

/** Every envelope kind; `readEnvelope` recognizes exactly these. */
const ENVELOPE_KINDS = {
  FINAL_ANSWER: true,
  MESSAGE: true,
  NEW_TASK: true,
} as const;

export interface Envelope {
  content: string;
  from: string;
  kind: keyof typeof ENVELOPE_KINDS;
  to: string;
}

export type PublicAgentStatus =
  | "interrupted"
  | "not_found"
  | "running"
  | { completed: string | null }
  | { errored: string };

export const emptyTree = (): Tree => ({ nodes: [], outbox: [], version: 4 });

export const emptyUsage = (): AgentUsage => ({
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  input: 0,
  output: 0,
});

export const envelopeText = (envelope: Envelope): string =>
  `Message Type: ${envelope.kind}\nTask name: ${envelope.to}\nSender: ${envelope.from}\nPayload:\n${envelope.content}`;

const ENVELOPE_PATTERN =
  /^Message Type: (?<kind>.*)\nTask name: (?<to>.*)\nSender: (?<from>.*)\nPayload:\n/u;

const isEnvelopeKind = (value: string): value is Envelope["kind"] =>
  Object.hasOwn(ENVELOPE_KINDS, value);

/** Reads an envelope back for display; the model always receives the text itself. */
export const readEnvelope = (text: string): Envelope | undefined => {
  const match = ENVELOPE_PATTERN.exec(text);
  const kind = match?.groups?.["kind"];
  const to = match?.groups?.["to"];
  const from = match?.groups?.["from"];

  if (
    match === null ||
    kind === undefined ||
    !isEnvelopeKind(kind) ||
    to === undefined ||
    from === undefined
  ) {
    return undefined;
  }

  return { content: text.slice(match[0].length), from, kind, to };
};

export const mailMessage = (mail: Mail) => ({
  content: envelopeText(mail),
  customType: SUBAGENT_MESSAGE_TYPE,
  details: {
    ...(mail.failed === true ? { failed: true } : {}),
    from: mail.from,
    id: mail.id,
    kind: mail.kind,
    to: mail.to,
  },
  // The root transcript shows mail as a card; child sessions run without a UI.
  display: true,
});

export const publicStatus = (
  node: AgentNode | undefined
): PublicAgentStatus => {
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

export const isAgentPath = (value: string): boolean => PATH_PATTERN.test(value);

export const childAgentPath = (caller: string, taskName: string): string => {
  if (!SEGMENT_PATTERN.test(taskName)) {
    throw new Error(
      "task_name must contain only lowercase letters, digits, and underscores"
    );
  }

  if (taskName === "root") {
    throw new Error("task_name root is reserved");
  }

  // The caller is a canonical agent path, so a valid segment yields one too.
  return `${caller}/${taskName}`;
};

export const resolveAgentPath = (caller: string, target: string): string => {
  if (target === "") {
    throw new Error("Agent target must not be blank");
  }

  const path = target.startsWith("/") ? target : `${caller}/${target}`;

  if (!isAgentPath(path)) {
    throw new Error(`Invalid agent path: ${path}`);
  }

  return path;
};

export const parentAgentPath = (path: string): string | undefined =>
  path === ROOT_AGENT_PATH ? undefined : path.slice(0, path.lastIndexOf("/"));
