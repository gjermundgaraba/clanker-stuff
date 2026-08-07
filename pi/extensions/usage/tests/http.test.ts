import { describe, expect, it, vi } from "vitest";

import { defaultFetchJson } from "../http.js";

describe(defaultFetchJson, () => {
  it("classifies an AbortSignal timeout as a request timeout", async () => {
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(AbortSignal.abort());
    vi.stubGlobal("fetch", async () => {
      throw new Error("aborted");
    });

    try {
      await expect(
        defaultFetchJson("https://example.test", { timeoutMs: 1 })
      ).resolves.toStrictEqual({ message: "request timed out", ok: false });
      expect(timeout).toHaveBeenCalledWith(1);
    } finally {
      timeout.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
