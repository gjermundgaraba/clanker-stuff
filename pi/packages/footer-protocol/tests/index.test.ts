import { describe, expect, it } from "vitest";

import {
  FOOTER_PROTOCOL_VERSION,
  FOOTER_READY_EVENT,
  FOOTER_READY_REQUEST_EVENT,
  FOOTER_WIDGET_EVENT,
  isFooterReadyMessage,
  isFooterReadyRequestMessage,
} from "../index.js";

describe("footer protocol", () => {
  it("exports the versioned event contract", () => {
    expect({
      ready: FOOTER_READY_EVENT,
      readyRequest: FOOTER_READY_REQUEST_EVENT,
      version: FOOTER_PROTOCOL_VERSION,
      widget: FOOTER_WIDGET_EVENT,
    }).toStrictEqual({
      ready: "clanker-footer:ready",
      readyRequest: "clanker-footer:ready-request",
      version: 1,
      widget: "clanker-footer:widget",
    });
    expect(
      isFooterReadyMessage({
        instanceId: "host",
        protocol: FOOTER_PROTOCOL_VERSION,
        type: "ready",
      })
    ).toBeTruthy();
    expect(
      isFooterReadyRequestMessage({
        protocol: FOOTER_PROTOCOL_VERSION,
        type: "ready-request",
      })
    ).toBeTruthy();
    expect(
      isFooterReadyMessage({
        instanceId: "host",
        protocol: 2,
        type: "ready",
      })
    ).toBeFalsy();
  });
});
