import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

export const COLLABORATION_CONTRACT_REQUEST = "clanker-stuff:subagents:contract:request";
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
  inheritedUltra?: boolean;
  nestedTools: readonly NestedToolContract[];
  protocol: "off" | "v1" | "v2";
  sessionId: string;
  version: 1;
}

const WireValueSchema = Type.Unknown();
type WireValue = Static<typeof WireValueSchema>;
const JsonRecordSchema = Type.Record(Type.String(), WireValueSchema);
type JsonRecord = Static<typeof JsonRecordSchema>;
const BooleanSchema = Type.Boolean();
const StringSchema = Type.String();
const FunctionSchema = Type.Function([], WireValueSchema);

interface NestedToolContract {
  definition: ToolDefinition;
  outputSchema?: unknown;
}

interface CollaborationApi {
  readonly events: {
    emit(channel: string, request: CollaborationContractRequest): void;
  };
}

interface CollaborationContext {
  readonly sessionManager: {
    getSessionId(): string;
  };
}

export interface CollaborationContractRequest {
  readonly context: ExtensionContext;
  readonly provide: (value: WireValue) => void;
  readonly sessionId: string;
  readonly ultra?: boolean;
}

const isRecord = (value: WireValue): value is JsonRecord => Value.Check(JsonRecordSchema, value);

const isToolDefinition = (value: WireValue): value is ToolDefinition =>
  isRecord(value) &&
  Value.Check(StringSchema, value.description) &&
  Value.Check(FunctionSchema, value.execute) &&
  Value.Check(StringSchema, value.label) &&
  Value.Check(StringSchema, value.name) &&
  isRecord(value.parameters);

const isNestedToolContract = (value: WireValue): value is NestedToolContract =>
  isRecord(value) &&
  isToolDefinition(value.definition) &&
  (value.outputSchema === undefined || isRecord(value.outputSchema));

const requestContract = (
  pi: CollaborationApi,
  ctx: ExtensionContext & CollaborationContext,
  ultra?: boolean,
): CollaborationContract | undefined => {
  let contract: CollaborationContract | undefined;
  const request: CollaborationContractRequest = {
    context: ctx,
    provide(value: WireValue) {
      if (
        isRecord(value) &&
        value.version === 1 &&
        value.sessionId === ctx.sessionManager.getSessionId() &&
        (value.protocol === "off" || value.protocol === "v1" || value.protocol === "v2") &&
        (value.inheritedUltra === undefined || Value.Check(BooleanSchema, value.inheritedUltra)) &&
        Array.isArray(value.nestedTools) &&
        value.nestedTools.every(isNestedToolContract)
      ) {
        contract = {
          nestedTools: value.nestedTools,
          protocol: value.protocol,
          sessionId: value.sessionId,
          version: value.version,
        };
        if (Value.Check(BooleanSchema, value.inheritedUltra)) {
          contract.inheritedUltra = value.inheritedUltra;
        }
      }
    },
    sessionId: ctx.sessionManager.getSessionId(),
  };
  pi.events.emit(
    COLLABORATION_CONTRACT_REQUEST,
    ultra === undefined ? request : { ...request, ultra },
  );
  return contract;
};
export const requestCollaborationContract = requestContract;

const toolName = (tool: WireValue): string | undefined =>
  isRecord(tool) && tool.type === "function" && Value.Check(StringSchema, tool.name)
    ? tool.name
    : undefined;

const namespaceTools = (
  tools: readonly WireValue[],
  contract: CollaborationContract | undefined,
): WireValue[] => {
  const present = tools.flatMap((tool) => {
    const name = toolName(tool);
    return name !== undefined && (V1_NAMES.has(name) || V2_NAMES.has(name)) ? [name] : [];
  });
  if (present.length === 0) {
    return [...tools];
  }
  const presentSet = new Set(present);
  const completeV1 = [...V1_NAMES].every((name) => presentSet.has(name));
  const completeV2 = [...V2_NAMES].every((name) => presentSet.has(name));
  if (contract === undefined) {
    if (completeV1 || completeV2) {
      throw new Error("Codex collaboration tools are active without a matching session contract");
    }
    return [...tools];
  }
  if (contract.protocol === "off") {
    if (!completeV1 && !completeV2) {
      return [...tools];
    }
    throw new Error("Codex collaboration tools are active without a matching session contract");
  }
  const expected = contract.protocol === "v1" ? V1_NAMES : V2_NAMES;
  if (present.length !== expected.size || present.some((name) => !expected.has(name))) {
    throw new Error("Codex collaboration tool family is incomplete or stale");
  }
  const selected: JsonRecord[] = [];
  const remaining: WireValue[] = [];
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
    .toSorted((left, right) => (toolName(left) ?? "").localeCompare(toolName(right) ?? "", "en-US"))
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
  payload: WireValue,
  pi: CollaborationApi,
  ctx: ExtensionContext & CollaborationContext,
) => {
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
    rewritten.input = input.map((item: WireValue) =>
      isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)
        ? { ...item, tools: namespaceTools(item.tools, contract) }
        : item,
    );
  }
  return rewritten;
};
