import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_CONFIG } from "../config.js";
import { NicknamePool } from "../nicknames.js";

describe(NicknamePool, () => {
  it("keeps names unique and adds ordinals after a role pool is exhausted", () => {
    const pool = new NicknamePool(
      {
        ...DEFAULT_CONFIG,
        roles: { reviewer: { nicknames: ["Scout"] } },
      },
      () => 0,
    );
    const reserved = new Set<string>();
    const choose = () => {
      const nickname = pool.choose("reviewer", reserved);
      reserved.add(nickname);
      return nickname;
    };

    expect([choose(), choose(), choose()]).toStrictEqual(["Scout", "Scout 2", "Scout 3"]);
  });
});
