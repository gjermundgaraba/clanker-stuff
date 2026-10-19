// Tool names, schemas, and descriptions in this file were adapted for this package from OpenAI Codex (Apache-2.0); see ./NOTICE and ./UPSTREAM.
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";

import { ThinkingSchema } from "./config.js";
import type { SubagentsConfig } from "./config.js";
import type { Controller } from "./controller.js";
import type { ForkTurns } from "./history.js";
import {
  FORK_TURNS_DESCRIPTION,
  MODEL_DESCRIPTION,
  REASONING_EFFORT_DESCRIPTION,
  roleDescription,
  SPAWN_DESCRIPTION,
} from "./prompts.js";
import { MAX_DURABLE_TEXT, MAX_STATUS_TEXT } from "./protocol.js";
import { agentRenderers } from "./renderers.js";

const STRICT = { additionalProperties: false } as const;

const parseForkTurns = (value: string | undefined): ForkTurns => {
  const normalized = value?.trim().toLowerCase() ?? "all";

  if (normalized === "all" || normalized === "none") {
    return normalized;
  }

  if (!/^[1-9][0-9]*$/u.test(normalized)) {
    throw new Error("fork_turns must be `none`, `all`, or a positive integer string");
  }

  return Math.min(Number(normalized), Number.MAX_SAFE_INTEGER);
};

const SPAWN_PROPERTIES = {
  fork_turns: Type.Optional(Type.String({ description: FORK_TURNS_DESCRIPTION })),
  message: Type.String({
    description: "Initial plain-text task for the new agent.",
    maxLength: MAX_DURABLE_TEXT,
    minLength: 1,
  }),
  model: Type.Optional(Type.String({ description: MODEL_DESCRIPTION, minLength: 1 })),
  reasoning_effort: Type.Optional({
    ...ThinkingSchema,
    description: REASONING_EFFORT_DESCRIPTION,
  }),
  task_name: Type.String({
    description: "Task name for the child. Use lowercase letters, digits, and underscores.",
    pattern: "^[a-z0-9_]+$",
  }),
};

/** `agent_type` is offered only when roles are configured. */
const spawnParameters = (config: SubagentsConfig) =>
  Object.keys(config.roles).length === 0
    ? Type.Object(SPAWN_PROPERTIES, STRICT)
    : Type.Object(
        {
          ...SPAWN_PROPERTIES,
          agent_type: Type.Optional(
            Type.String({
              description: [
                "Agent type override. Omit unless an explicit role is needed.",
                ...Object.entries(config.roles).map(([name, role]) => roleDescription(name, role)),
              ].join("\n"),
              minLength: 1,
            }),
          ),
        },
        STRICT,
      );

/** Message text shares the spawn task and final-answer limit: the tree or child session keeps it. */
const TargetMessageParameters = (target: string, message: string) =>
  Type.Object(
    {
      message: Type.String({ description: message, maxLength: MAX_DURABLE_TEXT, minLength: 1 }),
      target: Type.String({ description: target, minLength: 1 }),
    },
    STRICT,
  );

type SpawnParameters = Static<ReturnType<typeof spawnParameters>>;

const json = <Visible, Details>(visible: Visible, details: Details) => ({
  content: [{ text: JSON.stringify(visible), type: "text" as const }],
  details,
});

export type ToolController = Pick<
  Controller,
  "followUp" | "interrupt" | "list" | "sendMessage" | "spawn" | "wait"
>;

const empty = () => ({ content: [{ text: "", type: "text" as const }], details: {} });

interface ToolScope {
  caller: string;
  config: SubagentsConfig;
  controller: ToolController;
  pi: ExtensionAPI;
}

/** The collaboration tools by name, in registration order; each defines its tool for one agent. */
const TOOLS = {
  spawn_agent: ({ caller, config, controller, pi }: ToolScope, name: string) =>
    defineTool({
      description: SPAWN_DESCRIPTION,
      execute: async (_id, params: SpawnParameters, signal, _update, ctx) => {
        const spawned = await controller.spawn(
          caller,
          {
            agentType:
              "agent_type" in params && typeof params.agent_type === "string"
                ? params.agent_type
                : undefined,
            forkTurns: parseForkTurns(params.fork_turns),
            message: params.message,
            model: params.model,
            taskName: params.task_name,
            thinking: params.reasoning_effort,
            tools: pi.getActiveTools(),
          },
          ctx,
          signal,
        );

        return json({ task_name: spawned.task_name }, spawned);
      },
      executionMode: "parallel",
      exposure: "model-only",
      label: "Spawn Agent",
      name,
      parameters: spawnParameters(config),
      promptSnippet: "Spawn a child under your hierarchical task path",
    }),
  send_message: ({ caller, controller }: ToolScope, name: string) =>
    defineTool({
      description:
        "Queue context for an existing agent without starting a turn. Delivery follows Pi's turn boundaries; an idle recipient will not act until its next task. Use followup_task when a non-root agent needs to act.",
      execute: async (_id, params, signal) => {
        signal?.throwIfAborted();
        await controller.sendMessage(caller, params.target, params.message);

        return empty();
      },
      executionMode: "parallel",
      exposure: "model-only",
      label: "Send Message",
      name,
      parameters: TargetMessageParameters(
        "Relative or canonical task name to message, from spawn_agent.",
        "Message text to queue on the target agent.",
      ),
      promptSnippet: "Queue a message for another known agent",
    }),
  followup_task: ({ caller, controller }: ToolScope, name: string) =>
    defineTool({
      description:
        "Send a follow-up task to an existing non-root agent. If idle, start a turn; if running, deliver the task at a safe input boundary.",
      execute: async (_id, params, signal, _update, ctx) => {
        signal?.throwIfAborted();
        await controller.followUp(caller, params.target, params.message, ctx, signal);

        return empty();
      },
      executionMode: "parallel",
      exposure: "model-only",
      label: "Follow-up Task",
      name,
      parameters: TargetMessageParameters(
        "Relative or canonical non-root task name, from spawn_agent.",
        "Follow-up task text for the target agent.",
      ),
      promptSnippet: "Wake or continue a known agent with another task",
    }),
  wait_agent: ({ caller, controller }: ToolScope, name: string) =>
    defineTool({
      description:
        "Wait for mailbox activity from any agent or for steered user input. Returns a summary and timeout flag, never the message content.",
      execute: async (_id, params, signal) => {
        const waited = await controller.wait(caller, params.timeout_ms ?? 30_000, signal);

        return json(waited, waited);
      },
      executionMode: "parallel",
      exposure: "model-only",
      label: "Wait for Agent",
      name,
      parameters: Type.Object(
        {
          timeout_ms: Type.Optional(
            Type.Number({
              description: "Timeout in milliseconds. Defaults to 30000, min 10000, max 3600000.",
            }),
          ),
        },
        STRICT,
      ),
      promptSnippet: "Wait for incoming agent communication",
    }),
  interrupt_agent: ({ caller, controller }: ToolScope, name: string) =>
    defineTool({
      description:
        "Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
      execute: async (_id, params, signal) => {
        signal?.throwIfAborted();
        const interrupted = await controller.interrupt(caller, params.target);

        return json(interrupted, interrupted);
      },
      executionMode: "parallel",
      exposure: "model-only",
      label: "Interrupt Agent",
      name,
      parameters: Type.Object({ target: Type.String({ minLength: 1 }) }, STRICT),
      promptSnippet: "Interrupt another known agent's active turn",
    }),
  list_agents: ({ caller, controller }: ToolScope, name: string) =>
    defineTool({
      description: `List agents in the current root task tree with their latest status, optionally filtered by task-path prefix. Completed answers are cut to ${MAX_STATUS_TEXT} characters; the parent receives each in full as FINAL_ANSWER mail.`,
      execute: (_id, params) => {
        const agents = { agents: controller.list(caller, params.path_prefix) };

        return Promise.resolve(json(agents, agents));
      },
      executionMode: "parallel",
      exposure: "model-only",
      label: "List Agents",
      name,
      parameters: Type.Object(
        {
          path_prefix: Type.Optional(
            Type.String({
              description: "Task-path prefix without a trailing slash. Omit to list every agent.",
              minLength: 1,
            }),
          ),
        },
        STRICT,
      ),
      promptSnippet: "List the subagent tree and statuses",
    }),
};

/** Whether the named tool is one this extension registers and draws. */
export const isCollaborationTool = (name: string): boolean => Object.hasOwn(TOOLS, name);

/** Registers the collaboration tools for one agent; `caller` is its canonical path. */
export const registerTools = (
  pi: ExtensionAPI,
  controller: ToolController,
  caller: string,
  config: SubagentsConfig,
): void => {
  const scope = { caller, config, controller, pi };

  for (const [name, define] of Object.entries(TOOLS))
    pi.registerTool({ ...define(scope, name), ...agentRenderers(name) });
};
