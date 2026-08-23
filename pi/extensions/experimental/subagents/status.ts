export type PublicAgentStatus =
  | "pending_init"
  | "running"
  | "interrupted"
  | "shutdown"
  | "not_found"
  | { completed: string | null }
  | { errored: string };

interface AgentStatusSource {
  error?: string;
  lastAnswer?: string;
  status:
    | "pending"
    | "running"
    | "interrupted"
    | "completed"
    | "errored"
    | "shutdown";
}

export const publicStatus = (
  agent: AgentStatusSource | undefined
): PublicAgentStatus => {
  if (agent === undefined) {
    return "not_found";
  }
  if (agent.status === "pending") {
    return "pending_init";
  }
  if (agent.status === "completed") {
    return { completed: agent.lastAnswer ?? null };
  }
  if (agent.status === "errored") {
    return { errored: agent.error ?? "Agent failed" };
  }
  return agent.status;
};
