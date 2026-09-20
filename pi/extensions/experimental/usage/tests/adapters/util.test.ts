import { Type } from "typebox";
import { describe, expect, it, vi } from "vite-plus/test";

import { fetchBearerUsage } from "../../adapters/util.js";
import type { AdapterDeps } from "../../adapters/util.js";
import type { FetchJson } from "../../http.js";
import { usageResult } from "../../providers.js";
import { NOW, okFetch, tokenAuthClient } from "./helpers.js";

const URL = "https://usage.example/v1/credits";

const Schema = Type.Object({ available: Type.Number() });

const fetchUsage = (deps: AdapterDeps) =>
  fetchBearerUsage(deps, "openrouter", URL, Schema, (payload, nowMs) =>
    usageResult({
      accounting: { available: payload.available, kind: "credit-balance" },
      fetchedAt: nowMs,
      provider: "openrouter",
      quotaWindows: [],
    }),
  );

const failing =
  (status: number): FetchJson =>
  async () => ({ kind: "response", message: `HTTP ${status}`, ok: false, status });

describe("bearer usage fetch", () => {
  it("sends the credential as a bearer token and maps the checked payload", async () => {
    const client = { fetchJson: okFetch({ available: 3 }) } satisfies { fetchJson: FetchJson };
    const fetchJson = vi.spyOn(client, "fetchJson");

    const result = await fetchUsage({
      authClient: tokenAuthClient("token"),
      fetchJson: client.fetchJson,
      now: () => NOW,
    });

    expect(result).toMatchObject({
      ok: true,
      snapshot: { accounting: { available: 3 }, fetchedAt: NOW },
    });
    expect(fetchJson).toHaveBeenCalledExactlyOnceWith(
      URL,
      Schema,
      expect.objectContaining({
        headers: { Accept: "application/json", Authorization: "Bearer token" },
      }),
    );
  });

  it("does not send a request without a credential", async () => {
    const client = { fetchJson: okFetch({ available: 3 }) } satisfies { fetchJson: FetchJson };
    const fetchJson = vi.spyOn(client, "fetchJson");

    const result = await fetchUsage({
      authClient: { getProviderAuth: async () => undefined },
      fetchJson: client.fetchJson,
    });

    expect(result).toStrictEqual({
      error: { kind: "unavailable", message: "not logged in" },
      ok: false,
    });
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it.each([
    [401, "failure"],
    [403, "unavailable"],
    [503, "failure"],
  ] as const)("reports HTTP %s as %s", async (status, kind) => {
    await expect(
      fetchUsage({ authClient: tokenAuthClient("token"), fetchJson: failing(status) }),
    ).resolves.toStrictEqual({ error: { kind, message: `HTTP ${status}` }, ok: false });
  });

  it("rejects payloads that fail the schema", async () => {
    await expect(
      fetchUsage({
        authClient: tokenAuthClient("token"),
        fetchJson: okFetch({ available: "nope" }),
      }),
    ).resolves.toStrictEqual({
      error: { kind: "failure", message: "invalid usage payload" },
      ok: false,
    });
  });
});
