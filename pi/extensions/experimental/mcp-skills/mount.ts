import { homedir } from "node:os";
import path from "node:path";

import type { SkillEntry } from "./entry.js";

/** `~` and `~/` at the start of a path stand for the home directory, as Pi reads them. */
export const expandHome = (value: string): string => {
  if (value === "~") {
    return homedir();
  }

  return value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
};

/** Where loaded MCP skills are stored, outside every folder Pi discovers skills in. */
export const mountRoot = (agentDir: string): string =>
  path.join(agentDir, "mcp-skills");

/**
 * The folder one version of a skill is stored in once loaded:
 * `<root>/<server>/<8 hex of its revision>/<scheme>/<path after scheme://>`. The server label keeps
 * same-URI skills of two servers apart, and the revision keeps versions apart, so a folder never
 * changes once written.
 */
export const skillDir = (
  root: string,
  server: string,
  entry: SkillEntry
): string =>
  path.join(root, server, entry.revision.slice(0, 8), ...entry.rootSegments);

/** Where a file of a skill lies in its folder: its URI below the skill's root. */
export const filePath = (dir: string, entry: SkillEntry, uri: string): string =>
  path.join(dir, ...uri.slice(entry.root.length + 1).split("/"));

/** Whether a path lies inside the mount. */
export const isMounted = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);

  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(path.sep);
};
