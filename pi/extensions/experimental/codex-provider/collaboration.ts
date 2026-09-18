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
  inheritedServiceTier?: "priority" | null;
  inheritedUltra?: boolean;
  nestedTools: readonly NestedToolContract[];
  protocol: "off" | "v1" | "v2";
  sessionId: string;
  version: 1;
}

const JsonRecordSchema = Type.Record(Type.String(), Type.Unknown());

type JsonRecord = Static<typeof JsonRecordSchema>;

const FunctionSchema = Type.Function([], Type.Unknown());

const ServiceTierSchema = Type.Union([Type.Literal("priority"), Type.Null()]);

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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The cross-extension event bus supplies opaque contributions; the receiver validates the collaboration contract before accepting it.
  readonly provide: (value: unknown) => void;
  readonly rootServiceTier?: "priority" | null;
  readonly sessionId: string;
  readonly ultra?: boolean;
}

const isRecord = (value: unknown): value is JsonRecord => Value.Check(JsonRecordSchema, value);

const isToolDefinition = (value: unknown): value is ToolDefinition =>
  isRecord(value) &&
  typeof value.description === "string" &&
  Value.Check(FunctionSchema, value.execute) &&
  typeof value.label === "string" &&
  typeof value.name === "string" &&
  isRecord(value.parameters);

const isNestedToolContract = (value: unknown): value is NestedToolContract =>
  isRecord(value) &&
  isToolDefinition(value.definition) &&
  (value.outputSchema === undefined || isRecord(value.outputSchema));

const requestContract = (
  pi: CollaborationApi,
  ctx: ExtensionContext & CollaborationContext,
  ultra?: boolean,
  rootServiceTier?: "priority" | null,
): CollaborationContract | undefined => {
  let contract: CollaborationContract | undefined;
  const sessionId = ctx.sessionManager.getSessionId();

  const request: CollaborationContractRequest = {
    context: ctx,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The cross-extension event bus supplies opaque contributions; the receiver validates the collaboration contract before accepting it.
    provide(value: unknown) {
      if (!isRecord(value)) {
        return;
      }

      const { inheritedServiceTier, inheritedUltra, nestedTools, protocol } = value;

      if (
        value.version !== 1 ||
        value.sessionId !== sessionId ||
        (protocol !== "off" && protocol !== "v1" && protocol !== "v2") ||
        (inheritedServiceTier !== undefined &&
          !Value.Check(ServiceTierSchema, inheritedServiceTier)) ||
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Extension/wire boundary: validate the consumed contract fields before accepting untyped contributions.
        (inheritedUltra !== undefined && typeof inheritedUltra !== "boolean") ||
        !Array.isArray(nestedTools) ||
        !nestedTools.every(isNestedToolContract)
      ) {
        return;
      }

      contract = {
        ...(inheritedServiceTier !== undefined ? { inheritedServiceTier } : {}),
        ...(inheritedUltra !== undefined ? { inheritedUltra } : {}),
        nestedTools,
        protocol,
        sessionId,
        version: 1,
      };
    },
    ...(rootServiceTier !== undefined ? { rootServiceTier } : {}),
    sessionId,
    ...(ultra !== undefined ? { ultra } : {}),
  };

  pi.events.emit(COLLABORATION_CONTRACT_REQUEST, request);

  return contract;
};

export const requestCollaborationContract = requestContract;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Responses tool arrays contain heterogeneous wire items; only recognized function definitions participate in namespacing.
const toolName = (tool: unknown): string | undefined =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Extension/wire boundary: validate the consumed contract fields before accepting untyped contributions.
  isRecord(tool) && tool.type === "function" && typeof tool.name === "string"
    ? tool.name
    : undefined;

const namespaceTools = (
  tools: readonly unknown[],
  contract: CollaborationContract | undefined,
): unknown[] => {
  const present = tools.flatMap((tool) => {
    const name = toolName(tool);

    return name !== undefined && (V1_NAMES.has(name) || V2_NAMES.has(name)) ? [name] : [];
  });

  if (present.length === 0) {
    return [...tools];
  }

  const presentSet = new Set(present);
  const completeV1 = V1_NAMES.isSubsetOf(presentSet);
  const completeV2 = V2_NAMES.isSubsetOf(presentSet);

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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Pi provider hooks supply opaque requests; rewrite only recognized collaboration tools and preserve foreign fields unchanged.
  payload: unknown,
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
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Responses input is a heterogeneous wire array; only additional-tools items are interpreted by this adapter.
    rewritten.input = input.map((item: unknown) =>
      isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)
        ? { ...item, tools: namespaceTools(item.tools, contract) }
        : item,
    );
  }

  return rewritten;
};
