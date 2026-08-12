import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const TOOL_OWNER_CHANNEL = "clanker-stuff:tools:owner";

interface ToolOwnerRegistration {
  readonly names: readonly string[];
  readonly setEnabled: (
    name: string,
    enabled: boolean,
    ctx: ExtensionContext
  ) => void;
  readonly suppressedNames: (model?: Model<Api>) => readonly string[];
  readonly visibleNames: (model?: Model<Api>) => readonly string[];
}

const isToolOwnerRegistration = (
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

export const createToolOwners = (pi: ExtensionAPI) => {
  let registration: ToolOwnerRegistration | undefined;
  pi.events.on(TOOL_OWNER_CHANNEL, (value) => {
    if (isToolOwnerRegistration(value)) {
      registration = value;
    }
  });

  const ownerFor = (name: string) =>
    registration?.names.includes(name) === true ? registration : undefined;

  return {
    hasVisibleTools(model?: Model<Api>): boolean {
      return (registration?.visibleNames(model).length ?? 0) > 0;
    },
    isVisible(name: string, model?: Model<Api>): boolean {
      const owner = ownerFor(name);
      return owner?.visibleNames(model).includes(name) ?? false;
    },
    ownedActive(activeNames: ReadonlySet<string>): string[] {
      return [...activeNames].filter((name) => ownerFor(name) !== undefined);
    },
    owns(name: string): boolean {
      return ownerFor(name) !== undefined;
    },
    setEnabled(name: string, enabled: boolean, ctx: ExtensionContext): boolean {
      const owner = ownerFor(name);
      if (!owner) {
        return false;
      }
      owner.setEnabled(name, enabled, ctx);
      return true;
    },
    suppresses(name: string, model?: Model<Api>): boolean {
      return registration?.suppressedNames(model).includes(name) ?? false;
    },
  };
};
