import { describe, expect, it } from "vite-plus/test";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import {
  captureExecutionSettings,
  ToolExecutionSettings,
  withExecutionSettings,
} from "../tools/execution-context.js";

describe("execution settings", () => {
  it("is idempotent without losing fresh context on rebinding", () => {
    const host = createExtensionHost(() => {});
    const ctx = host.createContext({ cwd: "/first", thinkingLevel: "low" });
    const settings = captureExecutionSettings(ctx);
    const first = withExecutionSettings(ctx, settings);
    expect(withExecutionSettings(first)).toBe(first);
    expect(withExecutionSettings(first, settings)).toBe(first);
    const fresh = host.createContext({ cwd: "/second", thinkingLevel: "high" });
    const rebound = withExecutionSettings(fresh, settings);
    expect(rebound).not.toBe(first);
    expect(rebound.cwd).toBe("/second");
    expect(rebound.thinkingLevel).toBe("low");
    const changed = withExecutionSettings(first, { ...settings, thinkingLevel: "high" });
    expect(changed).not.toBe(first);
    expect(changed.thinkingLevel).toBe("high");
  });

  it("consumes multiple call IDs independently and isolates sessions and generations", () => {
    const store = new ToolExecutionSettings();
    const settings = { model: undefined, thinkingLevel: "low" as const };
    store.reset("root");
    const publish = store.beginResponse("root");
    publish(["one", "two"], settings);
    store.beginResponse("auxiliary")(["one"], { ...settings, thinkingLevel: "high" });
    expect(store.take("auxiliary", "one")).toBeUndefined();
    expect(store.take("root", "one")).toBe(settings);
    expect(store.take("root", "one")).toBeUndefined();
    expect(store.take("root", "two")).toBe(settings);
    store.clear();
    publish(["late"], settings);
    expect(store.take("root", "late")).toBeUndefined();
    const next = store.beginResponse("root");
    next(["unused"], settings);
    store.reset("other");
    next(["late"], settings);
    expect(store.take("other", "unused")).toBeUndefined();
    expect(store.take("root", "late")).toBeUndefined();
  });
});
