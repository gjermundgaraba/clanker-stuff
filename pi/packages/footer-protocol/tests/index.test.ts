import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import {
  FOOTER_PROTOCOL_VERSION,
  FOOTER_READY_EVENT,
  FOOTER_READY_REQUEST_EVENT,
  FOOTER_WIDGET_EVENT,
  FooterReadyMessageSchema,
  FooterReadyRequestMessageSchema,
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
      Value.Check(FooterReadyMessageSchema, {
        instanceId: "host",
        protocol: FOOTER_PROTOCOL_VERSION,
        type: "ready",
      }),
    ).toBeTruthy();
    expect(
      Value.Check(FooterReadyRequestMessageSchema, {
        protocol: FOOTER_PROTOCOL_VERSION,
        type: "ready-request",
      }),
    ).toBeTruthy();
    expect(
      Value.Check(FooterReadyMessageSchema, {
        instanceId: "host",
        protocol: 2,
        type: "ready",
      }),
    ).toBeFalsy();
  });
});
