import { fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";
import { resolveProtocol } from "../selection.js";

const model = fauxProvider({ models: [{ id: "model" }], provider: "provider" }).getModel();

describe(resolveProtocol, () => {
  it("uses exact, wildcard, then the stable V1 default", () => {
    expect([
      resolveProtocol(model, {}),
      resolveProtocol(undefined, {}),
      resolveProtocol(model, { "*": "v2" }),
      resolveProtocol(model, { "*": "v2", "provider/model": "auto" }),
      resolveProtocol(model, { "*": "v2", "provider/model": "off" }),
    ]).toStrictEqual(["v1", "v1", "v2", "v1", "off"]);
  });

  it("places explicit overrides before inherited state", () => {
    expect([
      resolveProtocol(model, {}, "v2"),
      resolveProtocol(model, { "*": "off" }, "v2"),
      resolveProtocol(model, { "*": "off", "provider/model": "auto" }, "v2"),
      resolveProtocol(model, { "*": "off", "provider/model": "v1" }, "v2"),
    ]).toStrictEqual(["v2", "off", "v2", "v1"]);
  });
});
