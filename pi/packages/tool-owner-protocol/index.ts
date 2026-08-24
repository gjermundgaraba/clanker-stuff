import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const TOOL_OWNER_PROTOCOL_VERSION = 1 as const;
export const TOOL_OWNER_REQUEST_EVENT = "clanker-stuff:tools:owner";

export interface ToolOwnerRegistration {
  readonly names: readonly string[];
  readonly setEnabled: (name: string, enabled: boolean, ctx: ExtensionContext) => void;
  readonly suppressedNames: (model?: Model<Api>) => readonly string[];
  readonly visibleNames: (model?: Model<Api>) => readonly string[];
}

export interface ToolOwnerRequest {
  readonly protocol: typeof TOOL_OWNER_PROTOCOL_VERSION;
  readonly type: "request";
  readonly provide: (registration: ToolOwnerRegistration) => void;
}

const ToolOwnerRegistrationSchema = Type.Object({
  names: Type.Array(Type.String()),
  setEnabled: Type.Function([Type.String(), Type.Boolean(), Type.Unknown()], Type.Void()),
  suppressedNames: Type.Function([Type.Optional(Type.Unknown())], Type.Array(Type.String())),
  visibleNames: Type.Function([Type.Optional(Type.Unknown())], Type.Array(Type.String())),
});

const ToolOwnerRequestSchema = Type.Object({
  protocol: Type.Literal(TOOL_OWNER_PROTOCOL_VERSION),
  provide: Type.Function([ToolOwnerRegistrationSchema], Type.Void()),
  type: Type.Literal("request"),
});

export const isToolOwnerRegistration = (
  value: Parameters<typeof Value.Check>[1],
): value is ToolOwnerRegistration => Value.Check(ToolOwnerRegistrationSchema, value);

export const isToolOwnerRequest = (
  value: Parameters<typeof Value.Check>[1],
): value is ToolOwnerRequest => Value.Check(ToolOwnerRequestSchema, value);
