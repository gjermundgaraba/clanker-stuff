import { describe, expect, it } from "vitest";

import { UsageCache } from "../cache.js";
import type { UsageSnapshot } from "../providers.js";

const snapshot = (overrides: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  fetchedAt: 1000,
  provider: "openai-codex",
  windows: [
    { id: "5h", label: "5h", remainingPercent: 68 },
    { id: "7d", label: "7d", remainingPercent: 66 },
  ],
  ...overrides,
});

describe("usage cache", () => {
  it("returns fresh success within TTL and fetches again after", async () => {
    let now = 10_000;
    let fetches = 0;
    const cache = new UsageCache({ now: () => now, ttlMs: 1000 });
    const fetcher = async () => {
      fetches += 1;
      return {
        ok: true as const,
        snapshot: snapshot({ fetchedAt: now }),
      };
    };

    await cache.getOrFetch("openai-codex", false, fetcher);
    now = 10_999;
    await cache.getOrFetch("openai-codex", false, fetcher);
    expect(fetches).toBe(1);

    now = 11_000;
    await cache.getOrFetch("openai-codex", false, fetcher);
    expect(fetches).toBe(2);
    expect(cache.getLastSuccess("openai-codex")?.fetchedAt).toBe(11_000);
  });

  it("shares a single in-flight fetch across callers", async () => {
    const cache = new UsageCache({ now: () => 5000 });
    let starts = 0;
    const { promise: gate, resolve: release } =
      Promise.withResolvers<UsageSnapshot>();

    const fetcher = async () => {
      starts += 1;
      const snap = await gate;
      return { ok: true as const, snapshot: snap };
    };

    const first = cache.getOrFetch("xai", true, fetcher);
    const second = cache.getOrFetch("xai", true, fetcher);
    expect(starts).toBe(1);

    release(
      snapshot({
        fetchedAt: 5000,
        provider: "xai",
        windows: [{ id: "month", label: "month", remainingPercent: 80 }],
      })
    );

    const [a, b] = await Promise.all([first, second]);
    expect(a.ok && b.ok).toBeTruthy();
    expect(starts).toBe(1);
  });

  it("does not clear lastSuccess or bump its fetchedAt on failure", async () => {
    let now = 1000;
    const cache = new UsageCache({ now: () => now });
    await cache.getOrFetch("openai-codex", true, async () => ({
      ok: true,
      snapshot: snapshot({ fetchedAt: 1000 }),
    }));

    now = 2000;
    const result = await cache.getOrFetch("openai-codex", true, async () => ({
      error: { kind: "failure" as const, message: "boom" },
      ok: false as const,
    }));

    expect(result.ok).toBeFalsy();
    const last = cache.getLastSuccess("openai-codex");
    expect(last?.fetchedAt).toBe(1000);
    expect(last?.windows[0]?.remainingPercent).toBe(68);
  });

  it("replaces lastSuccess on force refresh success", async () => {
    const cache = new UsageCache({ now: () => 3000 });
    await cache.getOrFetch("openai-codex", true, async () => ({
      ok: true,
      snapshot: snapshot({ fetchedAt: 1000 }),
    }));

    const result = await cache.getOrFetch("openai-codex", true, async () => ({
      ok: true as const,
      snapshot: snapshot({
        fetchedAt: 3000,
        windows: [{ id: "5h", label: "5h", remainingPercent: 10 }],
      }),
    }));

    expect(result.ok).toBeTruthy();
    expect(
      cache.getLastSuccess("openai-codex")?.windows[0]?.remainingPercent
    ).toBe(10);
  });
});
