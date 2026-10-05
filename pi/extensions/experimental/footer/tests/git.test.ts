import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { parseGitDetails, readGitDetails } from "../git.js";

const runtime = (result: ExecResult) => ({ exec: async () => await Promise.resolve(result) });

describe("git details", () => {
  it("counts porcelain-v2 changes and divergence", () => {
    expect(
      parseGitDetails(
        [
          "# branch.head main",
          "# branch.ab +2 -1",
          "1 M. N... 100644 100644 100644 a b file",
          "1 .M N... 100644 100644 100644 a b other",
          "? untracked",
        ].join("\n"),
      ),
    ).toStrictEqual({ ahead: 2, behind: 1, staged: 1, unstaged: 1, untracked: 1 });
  });

  it("treats a timed-out scan as a failure even though Pi reports exit code 0", async () => {
    await expect(
      readGitDetails(runtime({ code: 0, killed: true, stderr: "", stdout: "" }), "/repo"),
    ).rejects.toThrow("timed out");
  });

  it("treats a failed scan as a failure instead of a clean tree", async () => {
    await expect(
      readGitDetails(runtime({ code: 128, killed: false, stderr: "fatal", stdout: "" }), "/repo"),
    ).rejects.toThrow("code 128");
  });
});
