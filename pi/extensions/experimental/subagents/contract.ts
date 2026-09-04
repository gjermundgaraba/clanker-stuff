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
  readonly inheritedServiceTier?: RootServiceTier;
  readonly inheritedUltra?: boolean;
  readonly nestedTools: readonly NestedToolContract[];
  readonly protocol: Protocol;
  readonly sessionId: string;
  readonly version: 1;
}

export type RootServiceTier = "priority" | null;

interface ContractRequest {
  context: ProtocolResolutionContext;
  provide: (contract: CollaborationContract) => void;
  rootServiceTier?: RootServiceTier;
  sessionId: string;
  ultra?: boolean;
}

type ProtocolResolutionContext = Pick<
  ExtensionContext,
  "model" | "modelRegistry" | "sessionManager"
>;

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
      sessionManager: Type.Object(
        {
          getSessionId: Type.Function([], Type.String()),
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
      context: ProtocolResolutionContextSchema,
      provide: Type.Function([Type.Unknown()], Type.Void()),
      rootServiceTier: Type.Optional(Type.Union([Type.Literal("priority"), Type.Null()])),
      sessionId: Type.String(),
      ultra: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: true },
  ),
);

export const registerContractResponder = (
  pi: ExtensionAPI,
  current: (ctx: ProtocolResolutionContext) => Omit<CollaborationContract, "version"> | undefined,
  prepare?: (
    ctx: ProtocolResolutionContext,
    ultra: boolean | undefined,
    rootServiceTier: RootServiceTier | undefined,
  ) => void,
) =>
  pi.events.on(COLLABORATION_CONTRACT_REQUEST, (value) => {
    if (!Value.Check(ContractRequestSchema, value)) {
      return;
    }
    if (current(value.context)?.sessionId !== value.sessionId) {
      return;
    }
    prepare?.(value.context, value.ultra, value.rootServiceTier);
    const prepared = current(value.context);
    if (prepared?.sessionId === value.sessionId) {
      value.provide({ ...prepared, version: 1 });
    }
  });
