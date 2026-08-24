import { describe, expect, it } from "vite-plus/test";

import { TreeCoordinator } from "../coordinator.js";
import { freshSnapshot, createMemoryControlStore, rootBinding } from "../snapshot.js";
import type { ControlStore } from "../snapshot.js";

describe("tree coordinator", () => {
  it("serializes concurrent mutations against one authoritative snapshot", async () => {
    const root = rootBinding("tree");
    const coordinator = new TreeCoordinator();
    await coordinator.install(createMemoryControlStore(), freshSnapshot("v2", root), true);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        coordinator.transact((draft) => {
          if (draft.protocolLatch !== "v2") {
            throw new Error("Expected V2");
          }
          draft.state.nodes.push({
            nickname: `worker-${index}`,
            path: `/root/worker_${index}`,
            sessionFile: `/sessions/worker-${index}.jsonl`,
            status: "interrupted",
            tools: [],
          });
          draft.nicknames.push(`worker-${index}`);
        }),
      ),
    );
    expect(coordinator.state).toMatchObject({
      revision: 20,
      state: {
        nodes: expect.arrayContaining([expect.objectContaining({ path: "/root/worker_19" })]),
      },
    });
    expect(
      coordinator.state.protocolLatch === "v2" ? coordinator.state.state.nodes : [],
    ).toHaveLength(20);
  });

  it("activates an unlocked protocol before publishing its provisional state", async () => {
    const root = rootBinding("tree");
    const coordinator = new TreeCoordinator();
    await coordinator.install(createMemoryControlStore(), freshSnapshot("v1", root), false);
    let active = "v1";
    const observations: string[] = [];
    coordinator.subscribe((state) => {
      observations.push(`${active}:${state.protocolLatch}`);
    });

    await coordinator.installProvisional(
      createMemoryControlStore(),
      freshSnapshot("v2", root),
      () => {
        active = "v2";
      },
    );

    expect(observations).toStrictEqual(["v2:v2"]);
  });

  it("poisons the tree after a failed authoritative write", async () => {
    const root = rootBinding("tree");
    const coordinator = new TreeCoordinator();
    const failure = new Error("disk unavailable");
    const empty: Awaited<ReturnType<ControlStore["load"]>> = undefined;
    const store: ControlStore = {
      load: () => Promise.resolve(empty),
      persistent: true,
      write: () => Promise.reject(failure),
    };
    await coordinator.install(createMemoryControlStore(), freshSnapshot("v2", root), false);
    await expect(coordinator.install(store, freshSnapshot("v2", root), true)).rejects.toBe(failure);
    await expect(coordinator.command(() => "unreachable")).rejects.toBe(failure);
    await expect(coordinator.transact(() => "unreachable")).rejects.toBe(failure);
  });

  it("keeps a rename-committed mutation while blocking later work after uncertain durability", async () => {
    const root = rootBinding("tree");
    const coordinator = new TreeCoordinator();
    const uncertainty = new Error("directory sync failed");
    const empty: Awaited<ReturnType<ControlStore["load"]>> = undefined;
    const store: ControlStore = {
      load: () => Promise.resolve(empty),
      persistent: true,
      write: (_serialized, onCommit) => {
        onCommit();
        return Promise.resolve(uncertainty);
      },
    };
    await coordinator.install(createMemoryControlStore(), freshSnapshot("v2", root), false);

    await coordinator.install(store, freshSnapshot("v2", root), false);
    let committed = false;
    await coordinator.transact(
      (draft) => {
        draft.root.sessionId = "committed";
      },
      {
        onCommit: () => {
          committed = true;
        },
      },
    );

    expect(coordinator.state.protocolLatch).toBe("v2");
    expect(coordinator.state.root.sessionId).toBe("committed");
    expect(committed).toBeTruthy();
    expect(coordinator.error).toBe(uncertainty);
    await expect(coordinator.command(() => "blocked")).rejects.toBe(uncertainty);
  });
});
