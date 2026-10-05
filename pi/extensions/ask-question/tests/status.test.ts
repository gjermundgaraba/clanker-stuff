import { describe, expect, it } from "vite-plus/test";
import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { showInboxCount } from "../status.js";

describe("questionnaire inbox count", () => {
  it("shows the widget and footer status together and clears both at zero", () => {
    const host = createExtensionHost(() => {});
    const ctx = host.createContext();

    showInboxCount(ctx, 3);
    expect(host.getWidget("questionnaires")).toBe("3 questionnaires awaiting you · /answers");
    expect(host.getStatus("ask-question")).toBe("✉ 3");
    showInboxCount(ctx, 1);
    expect(host.getWidget("questionnaires")).toBe("1 questionnaire awaiting you · /answers");
    showInboxCount(ctx, 0);
    expect(host.getWidget("questionnaires")).toBeUndefined();
    expect(host.getStatus("ask-question")).toBeUndefined();
  });
  it("shows nothing outside the terminal", () => {
    const host = createExtensionHost(() => {});

    showInboxCount(host.createContext({ mode: "rpc" }), 1);
    expect(host.getWidget("questionnaires")).toBeUndefined();
    expect(host.getStatus("ask-question")).toBeUndefined();
  });
});
