import { createHash } from "node:crypto";
import { join } from "node:path";

import type { SkillEntry } from "./entry.js";
import { skillDir } from "./mount.js";
import type { ServerStatus } from "./servers.js";

/** A listed skill with the name and path the model and user see. */
export interface CatalogSkill {
  server: string;
  entry: SkillEntry;
  /** `<server>:<name>`, with a suffix from its URI when that name is not unique. */
  name: string;
  /** The folder this version of the skill is stored in once loaded. */
  dir: string;
  /** Path of the skill's `SKILL.md` in its folder. */
  path: string;
}

/**
 * Name every listed skill `<server>:<name>`. When a server lists a name twice, or the name is
 * already taken by a local skill or an earlier MCP skill, it gets `-` and hex digits of its URI
 * instead: 8, 16, or the whole digest. A skill's identity stays its server and URI; names only
 * label it.
 */
export const buildCatalog = (
  root: string,
  statuses: readonly ServerStatus[],
  localNames: ReadonlySet<string>,
): CatalogSkill[] => {
  const taken = new Set(localNames);

  return statuses.flatMap((status) => {
    const counts = new Map<string, number>();

    for (const entry of status.skills) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);

    return status.skills.flatMap((entry) => {
      const dir = skillDir(root, status.name, entry);

      if (dir === undefined) return [];

      const base = `${status.name}:${entry.name}`;
      const hash = createHash("sha256").update(entry.uri).digest("hex");

      const candidates = [
        ...(counts.get(entry.name) === 1 ? [base] : []),
        ...[8, 16].map((length) => `${base}-${hash.slice(0, length)}`),
      ];

      const name = candidates.find((candidate) => !taken.has(candidate)) ?? `${base}-${hash}`;

      taken.add(name);

      return [{ dir, entry, name, path: join(dir, "SKILL.md"), server: status.name }];
    });
  });
};
