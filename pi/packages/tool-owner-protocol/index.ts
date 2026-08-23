import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const TOOL_OWNER_PROTOCOL_VERSION = 1 as const;
export const TOOL_OWNER_REQUEST_EVENT = "clanker-stuff:tools:owner";

export interface ToolOwnerRegistration {
  readonly names: readonly string[];
  readonly setEnabled: (
    name: string,
    enabled: boolean,
    ctx: ExtensionContext
  ) => void;
  readonly suppressedNames: (model?: Model<Api>) => readonly string[];
  readonly visibleNames: (model?: Model<Api>) => readonly string[];
}

export interface ToolOwnerRequest {
  readonly protocol: typeof TOOL_OWNER_PROTOCOL_VERSION;
  readonly type: "request";
  readonly provide: (registration: ToolOwnerRegistration) => void;
}

export const isToolOwnerRegistration = (
  value: unknown
): value is ToolOwnerRegistration =>
  typeof value === "object" &&
  value !== null &&
  "names" in value &&
  Array.isArray(value.names) &&
  value.names.every((name) => typeof name === "string") &&
  "setEnabled" in value &&
  typeof value.setEnabled === "function" &&
  "suppressedNames" in value &&
  typeof value.suppressedNames === "function" &&
  "visibleNames" in value &&
  typeof value.visibleNames === "function";

export const isToolOwnerRequest = (value: unknown): value is ToolOwnerRequest =>
  typeof value === "object" &&
  value !== null &&
  "protocol" in value &&
  value.protocol === TOOL_OWNER_PROTOCOL_VERSION &&
  "type" in value &&
  value.type === "request" &&
  "provide" in value &&
  typeof value.provide === "function";
