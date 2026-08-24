import { randomInt } from "node:crypto";

import type { SubagentsConfig } from "./config.js";

const DEFAULT_NICKNAMES = [
  "Atlas",
  "Beacon",
  "Cedar",
  "Echo",
  "Juniper",
  "Orion",
  "Scout",
  "Sparrow",
] as const;

export class NicknamePool {
  readonly #config: SubagentsConfig;
  readonly #pick: (maximum: number) => number;

  constructor(config: SubagentsConfig, pick: (maximum: number) => number = randomInt) {
    this.#config = config;
    this.#pick = pick;
  }

  choose(role: string | undefined, reserved: ReadonlySet<string>): string {
    const candidates =
      (role === undefined ? undefined : this.#config.roles[role]?.nicknames) ?? DEFAULT_NICKNAMES;
    const available = candidates.filter((candidate) => !reserved.has(candidate));
    if (available.length > 0) {
      return available[this.#pick(available.length)];
    }

    const base = candidates[this.#pick(candidates.length)];
    let ordinal = 2;
    while (reserved.has(`${base} ${ordinal}`)) {
      ordinal += 1;
    }
    return `${base} ${ordinal}`;
  }
}
