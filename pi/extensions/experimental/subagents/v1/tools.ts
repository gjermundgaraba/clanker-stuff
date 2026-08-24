import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TProperties } from "typebox";

import { DEFAULT_CONFIG, ThinkingSchema } from "../config.js";
import type { AgentThinkingLevel, SubagentsConfig } from "../config.js";
import type { NestedToolContract } from "../contract.js";
import {
  configuredRoleDescription,
  REASONING_EFFORT_DESCRIPTION,
  v1SpawnDescription,
} from "../model-contract.js";
import type { V1Controller } from "./controller.js";
import { V1InputItemSchema } from "./input.js";
import type { V1InputItem } from "./input.js";

const STRICT = { additionalProperties: false } as const;
interface SpawnArguments {
  agent_type?: string;
  fork_context?: boolean;
  items?: V1InputItem[];
  message?: string;
  model?: string;
  reasoning_effort?: AgentThinkingLevel;
}
export type V1ToolController = Pick<
  V1Controller,
  "close" | "resume" | "sendInput" | "spawn" | "wait"
>;

type JsonValue =
  | boolean
  | null
  | number
  | string
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];
type JsonRecord = Record<string, JsonValue>;
const closedObject = (properties: JsonRecord, required: readonly string[]) => ({
  additionalProperties: false,
  properties,
  required,
  type: "object",
});
const AGENT_STATUS_SCHEMA = {
  oneOf: [
    {
      enum: ["pending_init", "running", "interrupted", "shutdown", "not_found"],
      type: "string",
    },
    closedObject({ completed: { type: ["string", "null"] } }, ["completed"]),
    closedObject({ errored: { type: "string" } }, ["errored"]),
  ],
} satisfies JsonRecord;
const V1_OUTPUT_SCHEMAS = new Map<string, JsonRecord>(
  Object.entries({
    close_agent: closedObject(
      {
        previous_status: {
          allOf: [AGENT_STATUS_SCHEMA],
          description: "The agent status observed before shutdown was requested.",
        },
      },
      ["previous_status"],
    ),
    resume_agent: closedObject({ status: AGENT_STATUS_SCHEMA }, ["status"]),
    send_input: closedObject(
      {
        submission_id: {
          description: "Identifier for the queued input submission.",
          type: "string",
        },
      },
      ["submission_id"],
    ),
    spawn_agent: closedObject(
      {
        agent_id: {
          description: "Thread identifier for the spawned agent.",
          type: "string",
        },
        nickname: {
          description: "User-facing nickname for the spawned agent when available.",
          type: ["string", "null"],
        },
      },
      ["agent_id", "nickname"],
    ),
    wait_agent: closedObject(
      {
        status: {
          additionalProperties: AGENT_STATUS_SCHEMA,
          description: "Final statuses keyed by agent id.",
          type: "object",
        },
        timed_out: {
          description:
            "Whether the wait call returned due to timeout before any agent reached a final status.",
          type: "boolean",
        },
      },
      ["status", "timed_out"],
    ),
  }),
);
const spawnCommon = (config: SubagentsConfig) => ({
  ...roleParameter(config),
  fork_context: Type.Optional(
    Type.Boolean({
      description:
        "True forks the current history; false or omitted starts with only the initial prompt.",
    }),
  ),
  ...modelParameters(config),
});
const roleParameter = (config: SubagentsConfig) =>
  Object.keys(config.roles).length === 0
    ? {}
    : {
        agent_type: Type.Optional(
          Type.String({
            description: [
              "Agent type override for the new agent. Omit unless an explicit role is needed.",
              ...Object.entries(config.roles).map(([name, role]) =>
                configuredRoleDescription(name, role),
              ),
            ].join("\n"),
            minLength: 1,
          }),
        ),
      };
const modelParameters = (config: SubagentsConfig) =>
  config.expose_spawn_agent_model_overrides
    ? {
        model: Type.Optional(
          Type.String({
            description:
              "Model override. Use a model id, or provider/model when the id is ambiguous.",
            minLength: 1,
          }),
        ),
        reasoning_effort: Type.Optional({
          ...ThinkingSchema,
          description: REASONING_EFFORT_DESCRIPTION,
        }),
      }
    : {};
const SendCommon = {
  interrupt: Type.Optional(
    Type.Boolean({
      description:
        "True interrupts current work and handles this input immediately; false or omitted queues it.",
    }),
  ),
  target: Type.String({
    description: "Agent id to message, from spawn_agent.",
    minLength: 1,
  }),
};

const result = <T>(value: T) => ({
  content: [{ text: JSON.stringify(value), type: "text" as const }],
  details: value,
});

export const registerV1Tools = (
  pi: ExtensionAPI,
  controller: V1ToolController,
  beforeExecute: (ctx: ExtensionContext) => void,
  config: SubagentsConfig = DEFAULT_CONFIG,
): NestedToolContract[] => {
  const spawnProperties: TProperties = {};
  Object.assign(spawnProperties, spawnCommon(config), {
    items: Type.Optional(
      Type.Array(V1InputItemSchema, {
        description: "Structured input items. Use either items or message.",
        minItems: 1,
      }),
    ),
    message: Type.Optional(
      Type.String({
        description: "Initial plain-text task. Use either message or items.",
        minLength: 1,
      }),
    ),
  });
  const spawnParameters = Type.Unsafe<SpawnArguments>(Type.Object(spawnProperties, STRICT));
  const definitions: ToolDefinition[] = [
    defineTool({
      description: v1SpawnDescription(config),
      execute: async (_id, params, signal, _update, ctx) => {
        beforeExecute(ctx);
        return result(
          await controller.spawn(
            {
              agentType: params.agent_type,
              forkContext: params.fork_context ?? false,
              items: params.items,
              message: params.message,
              model: params.model,
              thinking: params.reasoning_effort,
            },
            ctx,
            signal,
          ),
        );
      },
      executionMode: "parallel",
      label: "Spawn Agent",
      name: "spawn_agent",
      parameters: spawnParameters,
      promptSnippet: "Spawn a UUID-addressed independent agent",
    }),
    defineTool({
      description:
        "Send input to an existing open agent. Use interrupt=true to redirect work immediately. Reuse an agent when new work depends on its prior context. Provide exactly one of message or items.",
      execute: async (_id, params, signal, _update, ctx) => {
        beforeExecute(ctx);
        signal?.throwIfAborted();
        return result(
          await controller.sendInput(
            params.target,
            {
              interrupt: params.interrupt ?? false,
              items: "items" in params ? params.items : undefined,
              message: "message" in params ? params.message : undefined,
            },
            ctx,
            signal,
          ),
        );
      },
      executionMode: "parallel",
      label: "Send Agent Input",
      name: "send_input",
      parameters: Type.Object(
        {
          ...SendCommon,
          items: Type.Optional(
            Type.Array(V1InputItemSchema, {
              description: "Structured input items. Use either items or message.",
              minItems: 1,
            }),
          ),
          message: Type.Optional(
            Type.String({
              description: "Plain-text input to send. Use either message or items.",
              minLength: 1,
            }),
          ),
        },
        STRICT,
      ),
      promptSnippet: "Send more work to an open agent",
    }),
    defineTool({
      description:
        "Resume a previously closed agent by id so it can receive send_input and wait_agent calls.",
      execute: async (_id, params, signal, _update, ctx) => {
        beforeExecute(ctx);
        signal?.throwIfAborted();
        return result(await controller.resume(params.id, ctx, signal));
      },
      executionMode: "parallel",
      label: "Resume Agent",
      name: "resume_agent",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }, STRICT),
      promptSnippet: "Resume a closed UUID-addressed agent",
    }),
    defineTool({
      description:
        "Wait for agents to reach a final status. Completed statuses may include the final message. Returns an empty status object on timeout; prefer longer waits over polling.",
      execute: async (_id, params, signal, _update, ctx) => {
        beforeExecute(ctx);
        return result(await controller.wait(params.targets, params.timeout_ms ?? 30_000, signal));
      },
      executionMode: "parallel",
      label: "Wait for Agent",
      name: "wait_agent",
      parameters: Type.Object(
        {
          targets: Type.Array(Type.String({ minLength: 1 }), {
            description: "Agent ids to wait on. Multiple ids wait for whichever finishes first.",
            minItems: 1,
          }),
          timeout_ms: Type.Optional(
            Type.Number({
              description: "Timeout in milliseconds. Defaults to 30000, min 10000, max 3600000.",
            }),
          ),
        },
        STRICT,
      ),
      promptSnippet: "Wait for one or more UUID-addressed agents",
    }),
    defineTool({
      description:
        "Close an agent, discard its queued work, and return its previous status. Completed agents remain open and consume a slot until closed.",
      execute: async (_id, params, signal, _update, ctx) => {
        beforeExecute(ctx);
        signal?.throwIfAborted();
        return result(await controller.close(params.target, ctx, signal));
      },
      executionMode: "parallel",
      label: "Close Agent",
      name: "close_agent",
      parameters: Type.Object({ target: Type.String({ minLength: 1 }) }, STRICT),
      promptSnippet: "Close an agent when it is no longer needed",
    }),
  ];
  for (const definition of definitions) {
    pi.registerTool(definition);
  }
  return definitions.map((definition) => ({
    definition,
    outputSchema: V1_OUTPUT_SCHEMAS.get(definition.name),
  }));
};
