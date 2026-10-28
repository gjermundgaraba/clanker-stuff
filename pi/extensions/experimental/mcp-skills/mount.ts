import { homedir } from "node:os";
import path from "node:path";

import type { SkillEntry } from "./entry.js";

export const expandHome = (value: string): string => {
  if (value === "~") {
    return homedir();
  }

  return value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
};

export const mountRoot = (agentDir: string): string =>
  path.join(agentDir, "mcp-skills");

export const skillDir = (
  root: string,
  server: string,
  entry: SkillEntry
): string =>
  path.join(root, server, entry.revision.slice(0, 8), ...entry.rootSegments);

export const filePath = (dir: string, entry: SkillEntry, uri: string): string =>
  path.join(dir, ...uri.slice(entry.root.length + 1).split("/"));

export const isMounted = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);

  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(path.sep);
};
