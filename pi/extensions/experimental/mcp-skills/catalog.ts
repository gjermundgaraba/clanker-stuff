import { createHash } from "node:crypto";
import path from "node:path";

import type { SkillEntry } from "./entry.js";
import { skillDir } from "./mount.js";
import type { ServerStatus } from "./servers.js";

export interface CatalogSkill {
  server: string;
  entry: SkillEntry;
  name: string;
  dir: string;
  path: string;
}

export const buildCatalog = (
  root: string,
  statuses: readonly ServerStatus[],
  localNames: ReadonlySet<string>
): CatalogSkill[] => {
  const taken = new Set(localNames);

  return statuses.flatMap((status) => {
    const counts = new Map<string, number>();

    for (const entry of status.skills) {
      counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
    }

    return status.skills.map((entry) => {
      const dir = skillDir(root, status.name, entry);
      const base = `${status.name}:${entry.name}`;
      const hash = createHash("sha256").update(entry.uri).digest("hex");

      const candidates = [
        ...(counts.get(entry.name) === 1 ? [base] : []),
        ...[8, 16].map((length) => `${base}-${hash.slice(0, length)}`),
      ];

      const name =
        candidates.find((candidate) => !taken.has(candidate)) ??
        `${base}-${hash}`;

      taken.add(name);

      return {
        dir,
        entry,
        name,
        path: path.join(dir, "SKILL.md"),
        server: status.name,
      };
    });
  });
};
