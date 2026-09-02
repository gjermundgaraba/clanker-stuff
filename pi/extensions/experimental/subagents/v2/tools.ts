// Tool names, schemas, and descriptions in this file were adapted for this package from OpenAI Codex (Apache-2.0); see ../NOTICE and ../UPSTREAM.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TProperties } from "typebox";

import { DEFAULT_CONFIG, ThinkingSchema } from "../config.js";
import type { AgentThinkingLevel, SubagentsConfig } from "../config.js";
import type { ForkTurns } from "../history.js";
import {
  configuredRoleDescription,
  REASONING_EFFORT_DESCRIPTION,
  V2_FORK_TURNS_DESCRIPTION,
  v2SpawnDescription,
} from "../model-contract.js";
import { publicStatus } from "../status.js";
import type { V2Controller } from "./controller.js";

const STRICT = { additionalProperties: false } as const;
const ForkTurnsSchema = Type.String({
  description: V2_FORK_TURNS_DESCRIPTION,
});

const MAX_USIZE = 18_446_744_073_709_551_615n;

const parseForkTurns = (value: string | undefined): ForkTurns => {
  if (value === undefined) {
    return "all";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "all") {
    return "all";
  }
  if (normalized === "none") {
    return "none";
  }
  if (!/^\+?[0-9]+$/u.test(normalized)) {
    throw new Error("fork_turns must be `none`, `all`, or a positive integer string");
  }
  const turns = BigInt(normalized);
  if (turns === 0n || turns > MAX_USIZE) {
    throw new Error("fork_turns must be `none`, `all`, or a positive integer string");
  }
  return Number(turns > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : turns);
};

interface SpawnArguments {
  agent_type?: string;
  fork_turns?: string;
  message: string;
  model?: string;
  reasoning_effort?: AgentThinkingLevel;
  task_name: string;
}
export type V2ToolController = Pick<
  V2Controller,
  "followUp" | "interrupt" | "list" | "sendMessage" | "spawn" | "wait"
>;

const result = <Visible, Details>(visible: Visible, details: Details | Visible = visible) => ({
  content: [{ text: JSON.stringify(visible), type: "text" as const }],
  details,
});
const emptyResult = () => ({
  content: [{ text: "", type: "text" as const }],
  details: {},
});

export const registerV2Tools = (
  pi: ExtensionAPI,
  controller: V2ToolController,
  caller: string,
  beforeExecute: (ctx: ExtensionContext) => void,
  config: SubagentsConfig = DEFAULT_CONFIG,
): void => {
  const roleParameter =
    Object.keys(config.roles).length === 0
      ? {}
      : {
          agent_type: Type.Optional(
            Type.String({
              description: [
                "Agent type override. Omit unless an explicit role is needed.",
                ...Object.entries(config.roles).map(([name, role]) =>
                  configuredRoleDescription(name, role),
                ),
              ].join("\n"),
              minLength: 1,
            }),
          ),
        };
  const modelParameters = config.expose_spawn_agent_model_overrides
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
  const spawnProperties: TProperties = {};
  Object.assign(spawnProperties, roleParameter, modelParameters, {
    fork_turns: Type.Optional(ForkTurnsSchema),
    message: Type.String({
      description: "Initial plain-text task for the new agent.",
      minLength: 1,
    }),
    task_name: Type.String({
      description: "Task name for the child. Use lowercase letters, digits, and underscores.",
      pattern: "^[a-z0-9_]+$",
    }),
  });
  const spawnParameters = Type.Unsafe<SpawnArguments>(Type.Object(spawnProperties, STRICT));
  pi.registerTool({
    description: v2SpawnDescription(),
    execute: async (_id, params, signal, _update, ctx) => {
      beforeExecute(ctx);
      const spawned = await controller.spawn(
        caller,
        {
          agentType: params.agent_type,
          forkTurns: parseForkTurns(params.fork_turns),
          message: params.message,
          model: params.model,
          taskName: params.task_name,
          thinking: params.reasoning_effort,
        },
        ctx,
        signal,
      );
      return result({ task_name: spawned.task_name }, spawned);
    },
    executionMode: "parallel",
    label: "Spawn Agent",
    name: "spawn_agent",
    parameters: spawnParameters,
    promptSnippet: "Spawn a child under your hierarchical task path",
  });

  pi.registerTool({
    description:
      "Send a message to an existing agent. The message is delivered promptly and does not trigger a new turn.",
    execute: async (_id, params, signal, _update, ctx) => {
      beforeExecute(ctx);
      signal?.throwIfAborted();
      await controller.sendMessage(caller, params.target, params.message, ctx, signal);
      return emptyResult();
    },
    executionMode: "parallel",
    label: "Send Message",
    name: "send_message",
    parameters: Type.Object(
      {
        message: Type.String({
          description: "Message text to queue on the target agent.",
          minLength: 1,
        }),
        target: Type.String({
          description: "Relative or canonical task name to message, from spawn_agent.",
          minLength: 1,
        }),
      },
      STRICT,
    ),
    promptSnippet: "Queue a message for another known agent",
  });

  pi.registerTool({
    description:
      "Send a follow-up task to an existing non-root agent and trigger a turn if it is idle. If it is running, deliver the task at a safe input boundary.",
    execute: async (_id, params, signal, _update, ctx) => {
      beforeExecute(ctx);
      signal?.throwIfAborted();
      await controller.followUp(caller, params.target, params.message, ctx, signal);
      return emptyResult();
    },
    executionMode: "parallel",
    label: "Follow-up Task",
    name: "followup_task",
    parameters: Type.Object(
      {
        message: Type.String({
          description: "Follow-up task text for the target agent.",
          minLength: 1,
        }),
        target: Type.String({
          description: "Relative or canonical non-root task name, from spawn_agent.",
          minLength: 1,
        }),
      },
      STRICT,
    ),
    promptSnippet: "Wake or continue a known agent with another task",
  });

  pi.registerTool({
    description:
      "Wait for mailbox activity from any agent or for steered user input. Returns a summary and timeout flag, never the message content.",
    execute: async (_id, params, signal, _update, ctx) => {
      beforeExecute(ctx);
      return result(await controller.wait(caller, params.timeout_ms ?? 30_000, signal));
    },
    executionMode: "parallel",
    label: "Wait for Agent",
    name: "wait_agent",
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
  });

  pi.registerTool({
    description:
      "Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
    execute: async (_id, params, signal, _update, ctx) => {
      beforeExecute(ctx);
      signal?.throwIfAborted();
      return result(await controller.interrupt(caller, params.target, signal));
    },
    executionMode: "parallel",
    label: "Interrupt Agent",
    name: "interrupt_agent",
    parameters: Type.Object({ target: Type.String({ minLength: 1 }) }, STRICT),
    promptSnippet: "Interrupt another known agent's active turn",
  });

  pi.registerTool({
    description:
      "List live agents in the current root task tree, optionally filtered by task-path prefix.",
    execute: async (_id, params, _signal, _update, ctx) => {
      beforeExecute(ctx);
      return result({
        agents: controller
          .list(caller, params.path_prefix)
          .filter((agent) => agent.resident)
          .map((agent) => ({
            agent_name: agent.path,
            agent_status: publicStatus(agent),
          })),
      });
    },
    executionMode: "parallel",
    label: "List Agents",
    name: "list_agents",
    parameters: Type.Object(
      {
        path_prefix: Type.Optional(
          Type.String({
            description: "Task-path prefix without a trailing slash. Omit to list all live agents.",
            minLength: 1,
          }),
        ),
      },
      STRICT,
    ),
    promptSnippet: "List the durable subagent tree and statuses",
  });
};
