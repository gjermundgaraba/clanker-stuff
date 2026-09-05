import { describe, expect, it } from "vite-plus/test";

import { assertNativeModelContext } from "../scripts/live-installed.js";

describe("installed canary model context", () => {
  it.each([undefined, "list", "future_visibility"])(
    "rejects a missing picker entry with visibility %s",
    (codexVisibility) => {
      expect(() =>
        assertNativeModelContext({ contextWindow: 272_000, codexVisibility }, undefined),
      ).toThrow("native declared context window");
    },
  );

  it("allows explicitly hidden models outside the picker", () => {
    expect(() =>
      assertNativeModelContext({ contextWindow: 272_000, codexVisibility: "hide" }, undefined),
    ).not.toThrow();
  });

  it("requires the declared context for a listed model", () => {
    expect(() =>
      assertNativeModelContext({ contextWindow: 272_000 }, { contextWindow: 272_000 }),
    ).not.toThrow();
    expect(() =>
      assertNativeModelContext({ contextWindow: 8192 }, { contextWindow: 272_000 }),
    ).toThrow("native declared context window");
  });

  it("still rejects a forced small context for hidden models", () => {
    expect(() =>
      assertNativeModelContext({ contextWindow: 4096, codexVisibility: "hide" }, undefined),
    ).toThrow("native declared context window");
  });
});
