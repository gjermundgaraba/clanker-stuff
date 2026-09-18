import { describe, expect, it } from "vite-plus/test";

import { lint } from "./lint.js";

describe("module mocking through this repository's test entry point", () => {
  it.each(["vite-plus/test", "vitest"])("reports vi.mock imported from %s", (source) => {
    const result = lint(`import { vi } from "${source}"; vi.mock("./dependency.js");`);
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain("no-module-mocking");
  });

  it("ignores an unrelated object named vi", () => {
    const result = lint(
      'const vi = { mock(path: string) { return path; } }; vi.mock("./dependency.js");',
    );

    expect(result.status, result.stdout).toBe(0);
  });
});
