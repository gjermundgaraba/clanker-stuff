import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { Protocol } from "./selection.js";

export const COLLABORATION_CONTRACT_REQUEST =
  "clanker-stuff:subagents:contract:request";

export interface NestedToolContract {
  readonly definition: ToolDefinition;
  readonly outputSchema?: unknown;
}

export interface CollaborationContract {
  readonly nestedTools: readonly NestedToolContract[];
  readonly protocol: Protocol;
  readonly sessionId: string;
  readonly version: 1;
}

interface ContractRequest {
  context?: ProtocolResolutionContext;
  provide: (contract: CollaborationContract) => void;
  sessionId: string;
}

type ProtocolResolutionContext = Pick<
  ExtensionContext,
  "model" | "modelRegistry"
>;

const isProtocolResolutionContext = (
  value: unknown
): value is ProtocolResolutionContext =>
  typeof value === "object" &&
  value !== null &&
  "modelRegistry" in value &&
  typeof value.modelRegistry === "object" &&
  value.modelRegistry !== null &&
  "find" in value.modelRegistry &&
  typeof value.modelRegistry.find === "function";

const isContractRequest = (value: unknown): value is ContractRequest =>
  typeof value === "object" &&
  value !== null &&
  "provide" in value &&
  typeof value.provide === "function" &&
  "sessionId" in value &&
  typeof value.sessionId === "string" &&
  (!("context" in value) ||
    value.context === undefined ||
    isProtocolResolutionContext(value.context));

export const registerContractResponder = (
  pi: ExtensionAPI,
  current: () =>
    | {
        nestedTools: readonly NestedToolContract[];
        protocol: Protocol;
        sessionId: string;
      }
    | undefined,
  prepare?: (ctx: ProtocolResolutionContext) => void
) =>
  pi.events.on(COLLABORATION_CONTRACT_REQUEST, (value) => {
    if (!isContractRequest(value)) {
      return;
    }
    if (current()?.sessionId !== value.sessionId) {
      return;
    }
    if (value.context !== undefined) {
      prepare?.(value.context);
    }
    const prepared = current();
    if (prepared?.sessionId === value.sessionId) {
      value.provide({
        nestedTools: prepared.nestedTools,
        protocol: prepared.protocol,
        sessionId: prepared.sessionId,
        version: 1,
      });
    }
  });
