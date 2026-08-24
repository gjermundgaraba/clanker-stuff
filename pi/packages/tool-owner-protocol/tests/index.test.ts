import { describe, expect, it, vi } from "vite-plus/test";

import {
  isToolOwnerRegistration,
  isToolOwnerRequest,
  TOOL_OWNER_PROTOCOL_VERSION,
  TOOL_OWNER_REQUEST_EVENT,
} from "../index.js";
import type { ToolOwnerRegistration, ToolOwnerRequest } from "../index.js";

describe("tool-owner protocol", () => {
  it("exports and validates the request contract", () => {
    expect({
      event: TOOL_OWNER_REQUEST_EVENT,
      protocol: TOOL_OWNER_PROTOCOL_VERSION,
    }).toStrictEqual({
      event: "clanker-stuff:tools:owner",
      protocol: 1,
    });
    expect(
      isToolOwnerRequest({
        protocol: TOOL_OWNER_PROTOCOL_VERSION,
        provide: vi.fn<ToolOwnerRequest["provide"]>(),
        type: "request",
      }),
    ).toBeTruthy();
    expect(
      isToolOwnerRequest({
        protocol: 2,
        provide: vi.fn<ToolOwnerRequest["provide"]>(),
        type: "request",
      }),
    ).toBeFalsy();
  });

  it("validates owner registrations", () => {
    expect(
      isToolOwnerRegistration({
        names: ["exec_command"],
        setEnabled: vi.fn<ToolOwnerRegistration["setEnabled"]>(),
        suppressedNames: vi.fn<ToolOwnerRegistration["suppressedNames"]>(),
        visibleNames: vi.fn<ToolOwnerRegistration["visibleNames"]>(),
      }),
    ).toBeTruthy();
    expect(
      isToolOwnerRegistration({
        names: ["exec_command"],
        setEnabled: vi.fn<ToolOwnerRegistration["setEnabled"]>(),
      }),
    ).toBeFalsy();
  });
});
