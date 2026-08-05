import { isDeepStrictEqual } from "node:util";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface GitStatus {
  branch: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
}

const BRANCH_AB_PATTERN = /^# branch\.ab \+(?<ahead>\d+) -(?<behind>\d+)$/u;
const GIT_TIMEOUT_MS = 1000;

export const parseGitStatus = (output: string): GitStatus => {
  let branch: string | null = null;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let ahead = 0;
  let behind = 0;

  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      branch = head.length > 0 && head !== "(detached)" ? head : null;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = BRANCH_AB_PATTERN.exec(line);
      ahead = Number(match?.groups?.ahead ?? 0);
      behind = Number(match?.groups?.behind ?? 0);
      continue;
    }
    if (line.startsWith("? ")) {
      untracked += 1;
      continue;
    }
    if (
      line.startsWith("1 ") ||
      line.startsWith("2 ") ||
      line.startsWith("u ")
    ) {
      const xy = line.slice(2, 4);
      if (!xy.startsWith(".")) {
        staged += 1;
      }
      if (!xy.endsWith(".")) {
        unstaged += 1;
      }
    }
  }

  return { ahead, behind, branch, staged, unstaged, untracked };
};

export const readGitStatus = async (
  runtime: Pick<ExtensionAPI, "exec">,
  cwd: string
): Promise<GitStatus | null> => {
  try {
    const result = await runtime.exec(
      "git",
      ["status", "--porcelain=v2", "--branch"],
      { cwd, timeout: GIT_TIMEOUT_MS }
    );
    return result.code === 0 ? parseGitStatus(result.stdout) : null;
  } catch {
    return null;
  }
};

export const sameGitStatus = (
  left: GitStatus | null,
  right: GitStatus | null
): boolean => isDeepStrictEqual(left, right);
