import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { resolveProtocol } from "../selection.js";

const model = (version?: "disabled" | "v1" | "v2") =>
  ({
    id: "model",
    multiAgentVersion: version,
    provider: "provider",
  }) as unknown as Model<Api>;

describe(resolveProtocol, () => {
  it("uses exact, wildcard, declaration, then the V1 default", () => {
    expect([
      resolveProtocol(model("v2"), {}),
      resolveProtocol(model(), {}),
      resolveProtocol(model("disabled"), {}),
      resolveProtocol(model("v2"), { "*": "v1" }),
      resolveProtocol(model("v2"), {
        "*": "v1",
        "provider/model": "auto",
      }),
      resolveProtocol(model("v1"), { "provider/model": "off" }),
    ]).toStrictEqual(["v2", "v1", "off", "v1", "v2", "off"]);
  });

  it("places explicit overrides before inherited state and declarations", () => {
    expect([
      resolveProtocol(model("v1"), {}, "v2"),
      resolveProtocol(model("v1"), { "*": "off" }, "v2"),
      resolveProtocol(
        model("v1"),
        { "*": "off", "provider/model": "auto" },
        "v2"
      ),
      resolveProtocol(
        model("v1"),
        { "*": "off", "provider/model": "v1" },
        "v2"
      ),
    ]).toStrictEqual(["v2", "off", "v2", "v1"]);
  });
});
