import type { Api, Model } from "@earendil-works/pi-ai";

import type { RoleConfig, SubagentsConfig } from "./config.js";

const mailbox = (messageTypes: string) => `Mailbox input has this form:
Message Type: ${messageTypes}
Task name: <recipient>
Sender: <author>
Payload:
<payload text>`;

const ROOT_MAILBOX = mailbox("MESSAGE | FINAL_ANSWER");
const CHILD_MAILBOX = mailbox("NEW_TASK | MESSAGE | FINAL_ANSWER");

const joinLayers = (...layers: (string | undefined)[]): string =>
  layers
    .filter((layer): layer is string => layer !== undefined && layer !== "")
    .join("\n\n");

const usageLayer = (configured: string | undefined, fallback: string): string =>
  configured ?? fallback;

export const delegationPolicy = (config: SubagentsConfig): string =>
  config.prompts.delegation === "proactive"
    ? "Proactive delegation is enabled. Delegate concrete independent work when parallelism materially improves speed or quality."
    : "Explicit delegation is enabled. Spawn an agent only when the user, project instructions, or a skill explicitly requests delegation.";

export const modelDeclaresV2 = (model: Model<Api> | undefined): boolean =>
  model !== undefined &&
  "multiAgentVersion" in model &&
  model.multiAgentVersion === "v2";

export const v1RootPrompt = (
  config: SubagentsConfig,
  maxOpenAgents: number
): string =>
  joinLayers(
    "You are the root of a V1 collaboration tree. V1 children are UUID-addressed, do not receive collaboration tools, and report their final status to this session. All agents share the same cwd and filesystem, so edits are immediately visible.",
    usageLayer(
      config.prompts.v1?.root,
      `Use spawn_agent for concrete, bounded sidecar work with a disjoint write scope. Keep immediate blockers local, do not duplicate delegated work, and continue non-overlapping work while children run. At most ${maxOpenAgents} agents can be open; close_agent releases their slots. Reuse open agents with send_input and prefer longer wait_agent calls over busy polling.`
    ),
    delegationPolicy(config),
    "There is no shared rollout token budget."
  );

export const v1ChildPrompt = (
  config: SubagentsConfig,
  id: string,
  nickname: string
): string =>
  joinLayers(
    `You are V1 subagent ${nickname} (${id}). Your final response is reported to the root session; do not address the user directly. You do not have collaboration tools.`,
    usageLayer(
      config.prompts.child,
      "Complete the assigned task independently in the shared cwd and filesystem. Avoid edits outside the task's stated scope."
    )
  );

export const v2RootPrompt = (
  config: SubagentsConfig,
  maxChildren: number
): string =>
  joinLayers(
    `You are /root, the primary agent in a V2 collaboration tree. Canonical identities are hierarchical paths rooted at /root; a parent may address a direct child by its relative task name. All agents share the same cwd and filesystem, so edits are immediately visible. The root plus at most ${maxChildren} child turns can execute concurrently.`,
    usageLayer(
      config.prompts.v2?.root,
      "Use spawn_agent for concrete, bounded independent subtasks, send_message to queue context without triggering a turn, and followup_task to give an existing non-root agent another task and trigger a turn. Keep immediate blockers local, avoid duplicated work and overlapping write scopes, continue non-overlapping local work while children run, and prefer longer wait_agent calls over busy polling. A child receives V2 collaboration tools only when its resolved model declares V2; otherwise it must complete its task without spawning or messaging agents."
    ),
    delegationPolicy(config),
    ROOT_MAILBOX,
    "Full-history forks inherit surrounding conversation context. Model and reasoning overrides are intended for explicit requests or clear task-specific needs; prefer a fresh or partial fork when changing them. There is no shared rollout token budget."
  );

export const v2ChildBasePrompt = (
  config: SubagentsConfig,
  path: string,
  nickname?: string
): string =>
  joinLayers(
    `You are V2 subagent ${nickname ?? path} at ${path}. Your final response is delivered directly to your parent; do not address the user directly. Work in the shared cwd and filesystem, where edits are immediately visible to every agent.`,
    usageLayer(
      config.prompts.child,
      "Complete the concrete assigned task and keep changes within its stated scope."
    ),
    CHILD_MAILBOX
  );

export const v2ChildCapabilityPrompt = (
  config: SubagentsConfig,
  enabled: boolean
): string =>
  enabled
    ? joinLayers(
        usageLayer(
          config.prompts.v2?.child,
          "Your resolved model supports V2 collaboration tools. Use spawn_agent only for concrete independent subtasks, send_message for queue-only context, and followup_task to start or continue a non-root agent. Descendants receive these tools only when their own resolved models declare V2. Avoid duplicated work, overlapping write scopes, and busy polling."
        ),
        delegationPolicy(config)
      )
    : "Your resolved model does not provide V2 collaboration tools in this session. Complete the assigned task directly and return the result to your parent.";

export const v1SpawnDescription = (config: SubagentsConfig): string =>
  joinLayers(
    "Spawn a UUID-addressed sub-agent for a concrete, bounded task. The agent inherits the current model by default unless the selected role fixes another model. Provide exactly one of message or items. Returns the agent id and nickname.",
    delegationPolicy(config),
    "Delegate non-blocking work with a clear, disjoint scope. Keep critical-path work local, do not redo delegated work, and continue useful non-overlapping work while the agent runs."
  );

export const v2SpawnDescription = (): string =>
  "Spawn an agent for a concrete, bounded task. If the current task is /root/task1 and task_name is task_3, the child is /root/task1/task_3 and can be addressed as task_3 by its parent or by canonical path elsewhere. A child receives V2 collaboration tools only when its resolved model declares V2. Its final answer is delivered directly to its parent. fork_turns defaults to all; none passes no surrounding conversation context.";

export const V2_FORK_TURNS_DESCRIPTION =
  'Conversation context to inherit: "none", "all" (the default), or a positive integer string selecting that many recent user turns.';

export const REASONING_EFFORT_DESCRIPTION =
  "Reasoning effort override for the child. Omit to inherit the parent setting. A selected role with configured reasoning takes precedence over this value.";

export const configuredRoleDescription = (
  name: string,
  role: RoleConfig
): string => {
  const constraints = [
    role.model === undefined
      ? undefined
      : `configured model ${role.provider === undefined ? role.model : `${role.provider}/${role.model}`} cannot be overridden`,
    role.thinking === undefined
      ? undefined
      : `configured reasoning effort ${role.thinking} cannot be overridden`,
  ].filter((value): value is string => value !== undefined);
  const summary = role.description ?? `Pi role ${name}`;
  return `${name}: ${summary}${constraints.length === 0 ? "" : `; ${constraints.join("; ")}`}`;
};

export const formatV2ErrorCompletion = (message: string): string =>
  `Agent errored: ${message}\n\nThis agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.`;
