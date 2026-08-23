import {
  isToolOwnerRegistration,
  TOOL_OWNER_PROTOCOL_VERSION,
  TOOL_OWNER_REQUEST_EVENT,
} from "@clanker-stuff/tool-owner-protocol";
import type {
  ToolOwnerRegistration,
  ToolOwnerRequest,
} from "@clanker-stuff/tool-owner-protocol";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const createToolOwners = (pi: ExtensionAPI) => {
  let registration: ToolOwnerRegistration | undefined;

  const resolveRegistration = (): ToolOwnerRegistration | undefined => {
    if (registration) {
      return registration;
    }
    let candidate: ToolOwnerRegistration | undefined;
    let responses = 0;
    const request: ToolOwnerRequest = {
      protocol: TOOL_OWNER_PROTOCOL_VERSION,
      provide(value) {
        if (!isToolOwnerRegistration(value)) {
          return;
        }
        responses += 1;
        candidate ??= value;
      },
      type: "request",
    };
    pi.events.emit(TOOL_OWNER_REQUEST_EVENT, request);
    if (responses === 1) {
      registration = candidate;
    }
    return responses === 1 ? candidate : undefined;
  };

  const ownerFor = (name: string) => {
    const owner = resolveRegistration();
    return owner?.names.includes(name) === true ? owner : undefined;
  };

  return {
    hasVisibleTools(model?: Model<Api>): boolean {
      return (resolveRegistration()?.visibleNames(model).length ?? 0) > 0;
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
      return (
        resolveRegistration()?.suppressedNames(model).includes(name) ?? false
      );
    },
  };
};
