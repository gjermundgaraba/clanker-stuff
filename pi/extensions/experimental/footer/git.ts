import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Working-tree counts; the branch name comes from Pi's footer data. */
export interface GitDetails {
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
}

const BRANCH_AB_PATTERN = /^# branch\.ab \+(?<ahead>\d+) -(?<behind>\d+)$/u;

const GIT_TIMEOUT_MS = 1000;

export const parseGitDetails = (output: string): GitDetails => {
  const details: GitDetails = { ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 };

  for (const line of output.split("\n")) {
    const ab = BRANCH_AB_PATTERN.exec(line);

    if (ab) {
      details.ahead = Number(ab.groups?.ahead ?? 0);
      details.behind = Number(ab.groups?.behind ?? 0);
    } else if (line.startsWith("? ")) {
      details.untracked += 1;
    } else if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      const xy = line.slice(2, 4);

      if (!xy.startsWith(".")) details.staged += 1;

      if (!xy.endsWith(".")) details.unstaged += 1;
    }
  }

  return details;
};

/** Rejects on timeout or failure; Pi reports a timed-out process as exit code 0 with `killed`. */
export const readGitDetails = async (
  runtime: Pick<ExtensionAPI, "exec">,
  cwd: string,
): Promise<GitDetails> => {
  const result = await runtime.exec(
    "git",
    ["--no-optional-locks", "status", "--porcelain=v2", "--branch"],
    { cwd, timeout: GIT_TIMEOUT_MS },
  );

  if (result.killed) throw new Error(`git status timed out after ${GIT_TIMEOUT_MS}ms`);

  if (result.code !== 0) throw new Error(`git status exited with code ${result.code}`);

  return parseGitDetails(result.stdout);
};
