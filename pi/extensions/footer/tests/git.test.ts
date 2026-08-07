import { describe, expect, it } from "vitest";

import { parseGitStatus } from "../git.js";

describe("git status", () => {
  it("parses porcelain-v2 Git state", () => {
    expect(
      parseGitStatus(
        [
          "# branch.head main",
          "# branch.ab +2 -1",
          "1 M. N... 100644 100644 100644 a b file",
          "1 .M N... 100644 100644 100644 a b other",
          "? untracked",
        ].join("\n")
      )
    ).toStrictEqual({
      ahead: 2,
      behind: 1,
      branch: "main",
      staged: 1,
      unstaged: 1,
      untracked: 1,
    });
  });
});
