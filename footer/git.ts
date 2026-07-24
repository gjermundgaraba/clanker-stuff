import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface GitStatus {
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

const BRANCH_AB_PATTERN = /^# branch\.ab \+(?<ahead>\d+) -(?<behind>\d+)$/u;
const GIT_TIMEOUT_MS = 1000;

export const parseGitStatus = (output: string): GitStatus => {
  let branch: string | null = null;
  let dirty = false;
  let ahead = 0;
  let behind = 0;

  for (const line of output.split("\n")) {
    if (line.length === 0) {
      continue;
    }

    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      branch = head.length > 0 && head !== "(detached)" ? head : null;
      continue;
    }

    if (line.startsWith("# branch.ab ")) {
      const match = BRANCH_AB_PATTERN.exec(line);
      if (match !== null) {
        ahead = Math.trunc(Number(match.groups?.ahead ?? "0")) || 0;
        behind = Math.trunc(Number(match.groups?.behind ?? "0")) || 0;
      }
      continue;
    }

    if (!line.startsWith("# ")) {
      dirty = true;
    }
  }

  return { ahead, behind, branch, dirty };
};

export const readGitStatus = async (
  runtime: Pick<ExtensionAPI, "exec">,
  cwd: string
): Promise<GitStatus | null> => {
  try {
    const result = await runtime.exec(
      "git",
      ["status", "--porcelain=v2", "--branch"],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
      }
    );
    return result.code === 0 ? parseGitStatus(result.stdout) : null;
  } catch {
    return null;
  }
};

export const sameGitStatus = (
  left: GitStatus | null,
  right: GitStatus | null
): boolean => {
  if (left === right) {
    return true;
  }
  if (left === null || right === null) {
    return false;
  }
  return (
    left.branch === right.branch &&
    left.dirty === right.dirty &&
    left.ahead === right.ahead &&
    left.behind === right.behind
  );
};
