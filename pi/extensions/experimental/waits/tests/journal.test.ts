import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import { createActor } from "xstate";

import { ownedWaits, waitEntry } from "../journal.js";
import { waitMachine } from "../machine.js";
import { customEntry as custom } from "./helpers.js";

const actorFor = (id: string) =>
  createActor(waitMachine, {
    input: {
      id,
      openedAt: 0,
      spec: {
        label: id,
        condition: "false",
        instruction: "none",
        cwd: "/",
        intervalMs: 1000,
        checkTimeoutMs: 1000,
        timeoutMs: 10_000,
      },
    },
  });

const entryOf = (owner: string, actor: ReturnType<typeof actorFor>) =>
  waitEntry(
    owner,
    actor.getSnapshot().context.id,
    actor.getPersistedSnapshot()
  );

const ids = async (branch: SessionEntry[], owner: string) => {
  const snapshots = await ownedWaits(branch, owner);

  return snapshots.map((snapshot) => snapshot.context.id);
};

describe("ownedWaits", () => {
  it("keeps the newest entry of each wait the session owns", async () => {
    const a = actorFor("w_a").start();
    const opened = custom(entryOf("s1", a));
    a.send({ type: "wait.cancel" });
    const cancelled = custom(entryOf("s1", a));
    a.stop();

    const restored = await ownedWaits([opened, cancelled], "s1");
    expect(restored).toHaveLength(1);
    expect(restored[0]?.value).toBe("cancelled");
  });

  it("skips waits another session opened, such as a fork's parent", async () => {
    const a = actorFor("w_a").start();
    const b = actorFor("w_b").start();
    const branch = [custom(entryOf("parent", a)), custom(entryOf("s1", b))];
    a.stop();
    b.stop();

    await expect(ids(branch, "s1")).resolves.toStrictEqual(["w_b"]);
  });

  it("drops a wait whose newest entry does not fit, rather than reviving an older one", async () => {
    const a = actorFor("w_a").start();
    const valid = custom(entryOf("s1", a));
    a.stop();

    const wrongVersion = custom({
      ...entryOf("s1", a),
      snapshot: {
        ...a.getPersistedSnapshot(),
        machine: { id: "wait", version: "0" },
      },
    });

    const corrupt = custom({
      v: 1,
      id: "w_a",
      owner: "s1",
      snapshot: { value: "nowhere" },
    });

    await expect(ids([valid], "s1")).resolves.toStrictEqual(["w_a"]);
    await expect(ids([valid, wrongVersion], "s1")).resolves.toStrictEqual([]);
    await expect(ids([valid, corrupt], "s1")).resolves.toStrictEqual([]);
  });

  it("ignores other entry types and malformed envelopes", async () => {
    const a = actorFor("w_a").start();
    const entry = entryOf("s1", a);
    a.stop();

    await expect(
      ids(
        [custom(entry, "other"), custom({ ...entry, v: 2 }), custom(null)],
        "s1"
      )
    ).resolves.toStrictEqual([]);
  });
});
