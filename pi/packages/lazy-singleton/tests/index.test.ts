import { describe, expect, it, vi } from "vite-plus/test";

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
    expect(create).toHaveBeenCalledOnce();
    expect(firstValue).toStrictEqual({ id: "loaded" });
    expect(secondValue).toBe(firstValue);
    expect(onLoad).toHaveBeenCalledExactlyOnceWith(firstValue);
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

    const disposal = Promise.withResolvers<void>();
    const dispose = vi.fn<(value: { id: string }) => Promise<void>>(() => disposal.promise);
    const stopped = vi.fn<() => void>();
    const value = { id: "loaded" };

    const singleton = createLazySingleton(() => loading.promise);

    const load = singleton.load();
    const firstStop = singleton.stop(dispose);
    const secondStop = singleton.stop(dispose);
    expect(secondStop).toBe(firstStop);
    const completion = firstStop.then(stopped);
    loading.resolve(value);

    await expect(load).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledWith(value);
    expect(stopped).not.toHaveBeenCalled();

    disposal.resolve();
    await completion;
    expect(stopped).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledExactlyOnceWith(value);
    await expect(singleton.load()).resolves.toBeUndefined();
  });
});
