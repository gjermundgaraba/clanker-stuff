import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { ENDED, liveWaitsAcrossBranches, OPENED } from "../journal.js";
import type { Opened } from "../journal.js";

let sequence = 0;

const custom = (customType: string, data: unknown): SessionEntry => {
  sequence += 1;

  return {
    type: "custom",
    customType,
    data,
    id: `e${sequence}`,
    parentId: null,
    timestamp: new Date(0).toISOString(),
  };
};

const opened = (id: string, owner = "s1"): Opened => ({
  id,
  owner,
  expiresAt: 0,
  spec: {
    label: id,
    condition: "false",
    instruction: "none",
    cwd: "/",
    intervalSeconds: 1,
    checkTimeoutSeconds: 1,
  },
});

const ids = (entries: SessionEntry[]) =>
  liveWaitsAcrossBranches(entries, "s1").map((wait) => wait.id);

describe("liveWaitsAcrossBranches", () => {
  it("returns the session's waits that have not ended, in opening order", () => {
    expect(
      ids([
        custom(OPENED, opened("w_b")),
        custom(OPENED, opened("w_a")),
        custom(OPENED, opened("w_c")),
        custom(ENDED, { id: "w_a", outcome: "satisfied" }),
      ])
    ).toStrictEqual(["w_b", "w_c"]);
  });

  it("skips waits another session opened, such as a fork's parent", () => {
    expect(
      ids([
        custom(OPENED, opened("w_a", "parent")),
        custom(OPENED, opened("w_b")),
      ])
    ).toStrictEqual(["w_b"]);
  });

  it("skips entries that do not fit their schema", () => {
    const { cwd: _cwd, ...noCwd } = opened("w_a").spec;

    expect(
      ids([
        custom(OPENED, { ...opened("w_a"), spec: noCwd }),
        custom(OPENED, { ...opened("w_b"), extra: true }),
        custom(OPENED, null),
        custom("other", opened("w_c")),
      ])
    ).toStrictEqual([]);
  });

  it("ignores a malformed end, which leaves its wait live", () => {
    expect(
      ids([
        custom(OPENED, opened("w_a")),
        custom(ENDED, { id: "w_a", outcome: "fired" }),
      ])
    ).toStrictEqual(["w_a"]);
  });
});
