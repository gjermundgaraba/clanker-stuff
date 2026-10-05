// Mailbox, tool, and completion text adapted for this package from OpenAI Codex (Apache-2.0); see ./NOTICE and ./UPSTREAM.
import type { RoleConfig, SubagentsConfig } from "./config.js";

/** System prompt section carrying collaboration guidance; Pi wraps it in `<collaboration>`. */
export const COLLABORATION_SECTION = "collaboration";

const mailbox = (messageTypes: string) => `Mailbox input has this form:
Message Type: ${messageTypes}
Task name: <recipient>
Sender: <author>
Payload:
<payload text>`;

const delegationPolicy = (config: SubagentsConfig): string =>
  config.delegation === "proactive"
    ? "Proactive multi-agent delegation is enabled. User requests override this hint. If work can be parallelized, delegate concrete independent tasks when doing so could save time or improve quality."
    : "Explicit delegation is enabled. Spawn an agent only when the user, applicable project instructions, or a skill explicitly requests sub-agents, delegation, or parallel agent work. Requests for depth, thoroughness, research, investigation, or detailed codebase analysis do not count as permission to spawn.";

const OVERRIDE_POLICY =
  "Only set model or reasoning_effort when the user, applicable project instructions, or a skill explicitly requests it.";

export const rootPrompt = (config: SubagentsConfig): string =>
  [
    `You are /root, the primary agent in a collaboration tree. Canonical identities are hierarchical paths rooted at /root; a parent may address a direct child by its relative task name. All agents share the same cwd and filesystem, so edits are immediately visible. At most ${config.maxConcurrent} children can run or shut down at once.`,
    "Use spawn_agent for concrete, bounded independent subtasks, send_message to queue context without triggering a turn, and followup_task to give an existing non-root agent another task. Keep immediate blockers local, avoid duplicated work and overlapping write scopes, continue non-overlapping local work while children run, and prefer longer wait_agent calls over busy polling.",
    delegationPolicy(config),
    mailbox("MESSAGE | FINAL_ANSWER"),
    OVERRIDE_POLICY,
  ].join("\n\n");

export const childPrompt = (config: SubagentsConfig, path: string): string =>
  [
    `You are subagent ${path}. Your final response is delivered directly to your parent; do not address the user directly. Work in the shared cwd and filesystem, where edits are immediately visible to every agent. Complete the concrete assigned task and keep changes within its stated scope.`,
    "You have the same collaboration tools as your parent. Use spawn_agent only for concrete independent subtasks, send_message for queue-only context, and followup_task to continue a non-root agent. Avoid duplicated work, overlapping write scopes, and busy polling.",
    delegationPolicy(config),
    mailbox("NEW_TASK | MESSAGE | FINAL_ANSWER"),
    OVERRIDE_POLICY,
  ].join("\n\n");

export const SPAWN_DESCRIPTION =
  "Spawn an agent for a concrete, bounded task. If the current task is /root/task1 and task_name is task_3, the child is /root/task1/task_3 and can be addressed as task_3 by its parent or by canonical path elsewhere. Children share the tree's collaboration interface. Their final answer is delivered directly to their parent. fork_turns defaults to all; none passes no surrounding conversation context.";

export const FORK_TURNS_DESCRIPTION =
  'Conversation context to inherit: "none", "all" (the default), or a positive integer string selecting that many recent user turns. Inherited history keeps user messages, including images, final assistant text, and compaction summaries.';

export const MODEL_DESCRIPTION =
  "Explicit provider/model-id override. Omit to inherit the parent model. A selected role with a configured model takes precedence.";

export const REASONING_EFFORT_DESCRIPTION =
  "Reasoning effort override for the child. Omit to inherit the parent setting. A selected role with configured reasoning takes precedence over this value.";

export const roleDescription = (name: string, role: RoleConfig): string => {
  const constraints = [
    role.model === undefined ? undefined : `configured model ${role.model} cannot be overridden`,
    role.thinking === undefined
      ? undefined
      : `configured reasoning effort ${role.thinking} cannot be overridden`,
  ].filter((value): value is string => value !== undefined);

  const summary = role.description ?? `Pi role ${name}`;

  return `${name}: ${summary}${constraints.length === 0 ? "" : `; ${constraints.join("; ")}`}`;
};

export const errorCompletion = (message: string): string =>
  `Agent errored: ${message}\n\nThis agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.`;
