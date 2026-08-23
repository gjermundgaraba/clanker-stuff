import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const CONTRACT_REQUEST = "clanker-stuff:subagents:contract:request";
export const PI_SUBAGENTS_NAMESPACE = "pi_subagents";
const V1_NAMES = new Set([
  "close_agent",
  "resume_agent",
  "send_input",
  "spawn_agent",
  "wait_agent",
]);
const V2_NAMES = new Set([
  "followup_task",
  "interrupt_agent",
  "list_agents",
  "send_message",
  "spawn_agent",
  "wait_agent",
]);

export interface CollaborationContract {
  nestedTools: readonly NestedToolContract[];
  protocol: "off" | "v1" | "v2";
  sessionId: string;
  version: 1;
}

type JsonRecord = Record<string, unknown>;

interface NestedToolContract {
  definition: ToolDefinition;
  outputSchema?: unknown;
}

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isToolDefinition = (value: unknown): value is ToolDefinition =>
  isRecord(value) &&
  typeof value.description === "string" &&
  typeof value.execute === "function" &&
  typeof value.label === "string" &&
  typeof value.name === "string" &&
  isRecord(value.parameters);

const isNestedToolContract = (value: unknown): value is NestedToolContract =>
  isRecord(value) &&
  isToolDefinition(value.definition) &&
  (value.outputSchema === undefined || isRecord(value.outputSchema));

const requestContract = (
  pi: ExtensionAPI,
  ctx: ExtensionContext
): CollaborationContract | undefined => {
  let contract: CollaborationContract | undefined;
  pi.events.emit(CONTRACT_REQUEST, {
    context: ctx,
    provide(value: unknown) {
      if (
        isRecord(value) &&
        value.version === 1 &&
        value.sessionId === ctx.sessionManager.getSessionId() &&
        (value.protocol === "off" ||
          value.protocol === "v1" ||
          value.protocol === "v2") &&
        Array.isArray(value.nestedTools) &&
        value.nestedTools.every(isNestedToolContract)
      ) {
        contract = {
          nestedTools: value.nestedTools,
          protocol: value.protocol,
          sessionId: value.sessionId,
          version: value.version,
        };
      }
    },
    sessionId: ctx.sessionManager.getSessionId(),
  });
  return contract;
};
export const requestCollaborationContract = requestContract;

const toolName = (tool: unknown): string | undefined =>
  isRecord(tool) && tool.type === "function" && typeof tool.name === "string"
    ? tool.name
    : undefined;

const namespaceTools = (
  tools: readonly unknown[],
  contract: CollaborationContract | undefined
): unknown[] => {
  const present = tools.flatMap((tool) => {
    const name = toolName(tool);
    return name !== undefined && (V1_NAMES.has(name) || V2_NAMES.has(name))
      ? [name]
      : [];
  });
  if (present.length === 0) {
    return [...tools];
  }
  const presentSet = new Set(present);
  const completeV1 = [...V1_NAMES].every((name) => presentSet.has(name));
  const completeV2 = [...V2_NAMES].every((name) => presentSet.has(name));
  if (contract === undefined) {
    if (completeV1 || completeV2) {
      throw new Error(
        "Codex collaboration tools are active without a matching session contract"
      );
    }
    return [...tools];
  }
  if (contract.protocol === "off") {
    if (!completeV1 && !completeV2) {
      return [...tools];
    }
    throw new Error(
      "Codex collaboration tools are active without a matching session contract"
    );
  }
  const expected = contract.protocol === "v1" ? V1_NAMES : V2_NAMES;
  if (
    present.length !== expected.size ||
    present.some((name) => !expected.has(name))
  ) {
    throw new Error("Codex collaboration tool family is incomplete or stale");
  }
  const selected: JsonRecord[] = [];
  const remaining: unknown[] = [];
  let insertionIndex = 0;
  let foundFirst = false;
  for (const tool of tools) {
    const name = toolName(tool);
    if (isRecord(tool) && name !== undefined && expected.has(name)) {
      foundFirst = true;
      selected.push(tool);
    } else {
      remaining.push(tool);
      if (!foundFirst) {
        insertionIndex += 1;
      }
    }
  }
  const members = selected
    .toSorted((left, right) =>
      (toolName(left) ?? "").localeCompare(toolName(right) ?? "", "en-US")
    )
    .map((tool) => {
      const parameters = isRecord(tool.parameters)
        ? { ...tool.parameters, additionalProperties: false }
        : tool.parameters;
      return {
        ...tool,
        parameters,
        strict: false,
      };
    });
  remaining.splice(insertionIndex, 0, {
    description: "Pi tools for spawning and managing sub-agents.",
    name: PI_SUBAGENTS_NAMESPACE,
    tools: members,
    type: "namespace",
  });
  return remaining;
};

export const rewriteCollaborationTools = (
  payload: unknown,
  pi: ExtensionAPI,
  ctx: ExtensionContext
): unknown => {
  if (!isRecord(payload)) {
    return payload;
  }
  const contract = requestContract(pi, ctx);
  const rewritten = { ...payload };
  const { input, tools } = payload;
  if (Array.isArray(tools)) {
    rewritten.tools = namespaceTools(tools, contract);
  }
  if (Array.isArray(input)) {
    rewritten.input = input.map((item: unknown) =>
      isRecord(item) &&
      item.type === "additional_tools" &&
      Array.isArray(item.tools)
        ? { ...item, tools: namespaceTools(item.tools, contract) }
        : item
    );
  }
  return rewritten;
};
