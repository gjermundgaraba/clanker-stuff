import { describe, expect, it, vi } from "vitest";

import { createLazySingleton } from "../index.js";

describe("lazy singleton", () => {
  it("shares an in-flight load and caches the successful value", async () => {
    const loading = Promise.withResolvers<{ id: string }>();
    const create = vi.fn<() => Promise<{ id: string }>>(() => loading.promise);
    const onLoad = vi.fn<(value: { id: string }) => void>();
    const singleton = createLazySingleton(create, onLoad);

    const first = singleton.load();
    const second = singleton.load();
    loading.resolve({ id: "loaded" });

    const [firstValue, secondValue] = await Promise.all([first, second]);
    expect({
      createCalls: create.mock.calls.length,
      firstValue,
      onLoadCalls: onLoad.mock.calls,
      secondValue,
    }).toStrictEqual({
      createCalls: 1,
      firstValue: { id: "loaded" },
      onLoadCalls: [[{ id: "loaded" }]],
      secondValue: { id: "loaded" },
    });
    await expect(singleton.load()).resolves.toBe(firstValue);
  });

  it("retries after initialization fails", async () => {
    const value = { id: "loaded" };
    const create = vi
      .fn<() => Promise<typeof value>>()
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValueOnce(value);
    const singleton = createLazySingleton(create);

    await expect(singleton.load()).rejects.toThrow("load failed");
    await expect(singleton.load()).resolves.toBe(value);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("stops terminally and disposes an in-flight result once", async () => {
    const loading = Promise.withResolvers<{ id: string }>();
    const dispose = vi.fn<(value: { id: string }) => Promise<void>>(
      async () => await Promise.resolve()
    );
    const singleton = createLazySingleton(() => loading.promise);

    const load = singleton.load();
    const firstStop = singleton.stop(dispose);
    const secondStop = singleton.stop(dispose);
    loading.resolve({ id: "loaded" });

    await expect(load).resolves.toBeUndefined();
    await Promise.all([firstStop, secondStop]);
    await expect(singleton.load()).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
