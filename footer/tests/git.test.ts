import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { parseGitStatus, readGitStatus, sameGitStatus } from "../git.js";

describe("git status parsing", () => {
  it("parses branch, dirty state, and ahead/behind", () => {
    const status = parseGitStatus(
      [
        "# branch.oid abc123",
        "# branch.head main",
        "# branch.ab +2 -1",
        "1 .M N... 100644 100644 100644 aaa bbb file.ts",
        "? untracked.ts",
      ].join("\n")
    );
    expect(status).toStrictEqual({
      ahead: 2,
      behind: 1,
      branch: "main",
      dirty: true,
    });
  });

  it("treats detached HEAD as no branch", () => {
    const status = parseGitStatus("# branch.head (detached)\n");
    expect(status.branch).toBeNull();
    expect(status.dirty).toBeFalsy();
  });

  it("treats clean tree with no upstream as not dirty, zero ahead/behind", () => {
    const status = parseGitStatus("# branch.oid abc\n# branch.head feature\n");
    expect(status).toStrictEqual({
      ahead: 0,
      behind: 0,
      branch: "feature",
      dirty: false,
    });
  });

  it("runs porcelain v2 status through pi", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>(async () => ({
      code: 0,
      killed: false,
      stderr: "",
      stdout: "# branch.head main\n? new.ts\n",
    }));

    await expect(readGitStatus({ exec }, "/repo")).resolves.toStrictEqual({
      ahead: 0,
      behind: 0,
      branch: "main",
      dirty: true,
    });
    expect(exec).toHaveBeenCalledWith(
      "git",
      ["status", "--porcelain=v2", "--branch"],
      { cwd: "/repo", timeout: 1000 }
    );
  });
});

describe("git status equality", () => {
  const base = { ahead: 1, behind: 0, branch: "main", dirty: false };

  it("matches identical and differing states", () => {
    expect(sameGitStatus(null, null)).toBeTruthy();
    expect(sameGitStatus(base, { ...base })).toBeTruthy();
    expect(sameGitStatus(base, null)).toBeFalsy();
    expect(sameGitStatus(base, { ...base, dirty: true })).toBeFalsy();
    expect(sameGitStatus(base, { ...base, branch: "other" })).toBeFalsy();
  });
});
