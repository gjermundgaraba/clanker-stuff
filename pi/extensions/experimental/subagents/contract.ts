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
  readonly inheritedUltra?: boolean;
  readonly nestedTools: readonly NestedToolContract[];
  readonly protocol: Protocol;
  readonly sessionId: string;
  readonly version: 1;
}

interface ContractRequest {
  context?: ProtocolResolutionContext;
  provide: (contract: CollaborationContract) => void;
  sessionId: string;
  ultra?: boolean;
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
      ultra: Type.Optional(Type.Boolean()),
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
        inheritedUltra?: boolean;
      }
    | undefined,
  prepare?: (ctx: ProtocolResolutionContext, ultra: boolean) => void,
) =>
  pi.events.on(COLLABORATION_CONTRACT_REQUEST, (value) => {
    if (!Value.Check(ContractRequestSchema, value)) {
      return;
    }
    if (current()?.sessionId !== value.sessionId) {
      return;
    }
    if (value.context !== undefined) {
      prepare?.(value.context, value.ultra ?? false);
    }
    const prepared = current();
    if (prepared?.sessionId === value.sessionId) {
      const contract: CollaborationContract = {
        nestedTools: prepared.nestedTools,
        protocol: prepared.protocol,
        sessionId: prepared.sessionId,
        version: 1,
      };
      value.provide(
        prepared.inheritedUltra === undefined
          ? contract
          : { ...contract, inheritedUltra: prepared.inheritedUltra },
      );
    }
  });
