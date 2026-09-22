import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createRealCodexSession } from "./agent-session.js";
import { responseEvents, sse } from "./fixtures.js";

type OrderedHook =
  | "before_provider_headers"
  | "before_provider_request"
  | "context"
  | "session_before_compact";

interface HookRecord {
  hook: OrderedHook;
  label: string;
}

// Production registers these hooks in its extension factory. Their load-order chaining is
// the host contract behind auditLocalOrder's requirement that this package resolve last.
const orderedProbe =
  (label: string, records: HookRecord[]): ExtensionFactory =>
  (pi) => {
    pi.on("context", () => {
      records.push({ hook: "context", label });
    });
    pi.on("before_provider_request", () => {
      records.push({ hook: "before_provider_request", label });
    });
    pi.on("before_provider_headers", () => {
      records.push({ hook: "before_provider_headers", label });
    });
    pi.on("session_before_compact", () => {
      records.push({ hook: "session_before_compact", label });
    });
  };

const expectTargetBeforeAdversary = (records: readonly HookRecord[]) => {
  const hooks: OrderedHook[] = [
    "context",
    "before_provider_request",
    "before_provider_headers",
    "session_before_compact",
  ];

  for (const hook of hooks) {
    const labels = records.flatMap((record) => (record.hook === hook ? [record.label] : []));
    expect(labels.length).toBeGreaterThanOrEqual(2);

    for (let index = 0; index < labels.length; index += 2) {
      expect(labels.slice(index, index + 2)).toStrictEqual(["target", "adversary"]);
    }
  }
};

const workspace = async (prefix: string) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const cwd = path.join(rootDir, "project");
  await mkdir(cwd, { recursive: true });

  return { cwd, rootDir };
};

describe("public Pi hook ordering", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("chains factory-registered hooks in load order before and after reload", async () => {
    expect.hasAssertions();
    const paths = await workspace("codex-order-reload-");
    const records: HookRecord[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sse(responseEvents(crypto.randomUUID(), "order-probe"))),
    );

    const session = await createRealCodexSession({
      compaction: {
        enabled: true,
        keepRecentTokens: 1,
        reserveTokens: 1000,
      },
      extensionFactories: [orderedProbe("target", records), orderedProbe("adversary", records)],
      rootDir: paths.rootDir,
      sessionManager: SessionManager.inMemory(paths.cwd),
    });

    try {
      await session.prompt("hook order");
      await session.compact();
      expectTargetBeforeAdversary(records);

      await session.reload();
      records.length = 0;
      await session.prompt("hook order after reload");
      await session.compact();
      expectTargetBeforeAdversary(records);
    } finally {
      session.dispose();
      await rm(paths.rootDir, { force: true, recursive: true });
    }
  });
});
