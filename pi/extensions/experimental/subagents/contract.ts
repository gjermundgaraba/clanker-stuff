import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { Protocol } from "./selection.js";

export const COLLABORATION_CONTRACT_REQUEST = "clanker-stuff:subagents:contract:request";

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

type ProtocolResolutionContext = Pick<ExtensionContext, "model" | "modelRegistry">;

const ProtocolResolutionContextSchema = Type.Unsafe<ProtocolResolutionContext>(
  Type.Object(
    {
      model: Type.Optional(Type.Unknown()),
      modelRegistry: Type.Object(
        {
          find: Type.Function([], Type.Unknown()),
        },
        { additionalProperties: true },
      ),
    },
    { additionalProperties: true },
  ),
);
const ContractRequestSchema = Type.Unsafe<ContractRequest>(
  Type.Object(
    {
      context: Type.Optional(ProtocolResolutionContextSchema),
      provide: Type.Function([Type.Unknown()], Type.Void()),
      sessionId: Type.String(),
    },
    { additionalProperties: true },
  ),
);

export const registerContractResponder = (
  pi: ExtensionAPI,
  current: () =>
    | {
        nestedTools: readonly NestedToolContract[];
        protocol: Protocol;
        sessionId: string;
      }
    | undefined,
  prepare?: (ctx: ProtocolResolutionContext) => void,
) =>
  pi.events.on(COLLABORATION_CONTRACT_REQUEST, (value) => {
    if (!Value.Check(ContractRequestSchema, value)) {
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
