import {
  isToolOwnerRequest,
  TOOL_OWNER_REQUEST_EVENT,
} from "@clanker-stuff/tool-owner-protocol";
import type { ToolOwnerRegistration } from "@clanker-stuff/tool-owner-protocol";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { createToolOwners } from "../ownership.js";

const registration = (name: string): ToolOwnerRegistration => ({
  names: [name],
  setEnabled: vi.fn<ToolOwnerRegistration["setEnabled"]>(),
  suppressedNames: () => [],
  visibleNames: () => [name],
});

const respondWith = (owner: ToolOwnerRegistration) => (pi: ExtensionAPI) => {
  pi.events.on(TOOL_OWNER_REQUEST_EVENT, (request) => {
    if (isToolOwnerRequest(request)) {
      request.provide(owner);
    }
  });
};

describe("tool ownership discovery", () => {
  it("treats an absent or malformed responder as unowned", async () => {
    let owners: ReturnType<typeof createToolOwners> | undefined;
    const host = createExtensionHost((pi) => {
      pi.events.on(TOOL_OWNER_REQUEST_EVENT, (request) => {
        if (isToolOwnerRequest(request)) {
          request.provide({ names: ["broken"] } as never);
        }
      });
      owners = createToolOwners(pi);
    });
    await host.ready;

    expect(owners?.owns("broken")).toBeFalsy();

    const absentHost = createExtensionHost((pi) => {
      owners = createToolOwners(pi);
    });
    await absentHost.ready;
    expect(owners?.owns("missing")).toBeFalsy();
  });

  it("fails closed when multiple owners respond", async () => {
    let owners: ReturnType<typeof createToolOwners> | undefined;
    const host = createExtensionHost((pi) => {
      respondWith(registration("first"))(pi);
      respondWith(registration("second"))(pi);
      owners = createToolOwners(pi);
    });
    await host.ready;

    expect({
      first: owners?.owns("first"),
      second: owners?.owns("second"),
    }).toStrictEqual({ first: false, second: false });
  });
});
