import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import {
  FOOTER_PROTOCOL_VERSION,
  FOOTER_READY_EVENT,
  FOOTER_READY_REQUEST_EVENT,
  FOOTER_WIDGET_EVENT,
  FooterContentSchema,
  FooterReadyMessageSchema,
  FooterReadyRequestMessageSchema,
  MAX_FOOTER_CONTENT_SPANS,
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

  it("shares the content span limit with producers", () => {
    const span = { text: "usage" };

    expect(
      Value.Check(
        FooterContentSchema,
        Array.from({ length: MAX_FOOTER_CONTENT_SPANS }, () => span),
      ),
    ).toBe(true);
    expect(
      Value.Check(
        FooterContentSchema,
        Array.from({ length: MAX_FOOTER_CONTENT_SPANS + 1 }, () => span),
      ),
    ).toBe(false);
  });
});
