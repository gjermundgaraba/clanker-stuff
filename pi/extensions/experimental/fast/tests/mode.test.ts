import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { loadFastDefault } from "../config.js";
import { createFastMode } from "../mode.js";

const model = {
  ...fauxProvider({
    provider: "openai",
    api: "openai-responses",
    models: [{ id: "arbitrary-native-model" }],
  }).getModel(),
  baseUrl: "https://api.openai.com/v1",
};

const payload = {
  type: "before_provider_request" as const,
  payload: { model: model.id, input: ["keep"], service_tier: "default" },
};

const startup = { type: "session_start" as const, reason: "startup" as const };

const reload = { ...startup, reason: "reload" as const };

describe("Fast local preference", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "fast-mode-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const setup = async (flag = false, reader: typeof loadFastDefault = loadFastDefault) => {
    const configPath = path.join(root, "fast.json");
    const instance = Promise.withResolvers<ReturnType<typeof createFastMode>>();

    const host = createExtensionHost(
      (pi) => {
        pi.registerFlag("fast", { description: "Test startup flag", type: "boolean" });
        instance.resolve(createFastMode(pi, configPath, reader));
      },
      { flags: { fast: flag }, model },
    );

    await host.ready;

    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });

    const ctx = host.createContext({
      modelRegistry: {
        find: () => model,
        isUsingOAuth: () => true,
        getProvider: (id) => runtime.getProvider(id),
      },
    });

    return { host, ctx, configPath, mode: await instance.promise };
  };

  it("toggles synchronously without creating files, preserves payloads and rejects arguments", async () => {
    const { mode, host, ctx } = await setup();
    await mode.start(startup, ctx);
    expect(await readdir(root)).toStrictEqual([]);
    expect(mode.payload(payload, ctx)).toBeUndefined();
    mode.toggle("", ctx);
    expect(mode.payload(payload, ctx)).toStrictEqual({
      ...payload.payload,
      service_tier: "priority",
    });
    expect(payload.payload.service_tier).toBe("default");
    expect(host.getStatus("fast")).toContain("⚡ Fast requested");
    expect(mode.payload({ ...payload, payload: { model: "other" } }, ctx)).toBeUndefined();
    expect(mode.payload({ ...payload, payload: null }, ctx)).toBeUndefined();
    mode.toggle("on", ctx);
    expect(host.getNotifications().at(-1)?.message).toBe("Usage: /fast");
    expect(mode.payload(payload, ctx)?.service_tier).toBe("priority");
    mode.toggle("", ctx);
    expect(mode.payload(payload, ctx)).toBeUndefined();
    expect(host.getStatus("fast")).toBeUndefined();
    expect(await readdir(root)).toStrictEqual([]);
  });

  it("shows enabled intent outside native routing but leaves the payload untouched", async () => {
    const { mode, host, ctx } = await setup(true);
    const unsupported = { ...ctx, model: { ...model, baseUrl: "https://custom.invalid/v1" } };

    await mode.start(startup, unsupported);
    expect(host.getStatus("fast")).toContain("⚡ Fast requested");
    expect(mode.payload(payload, unsupported)).toBeUndefined();
    expect(host.getStatus("fast")).toContain("⚡ Fast requested");
    expect(mode.payload(payload, ctx)?.service_tier).toBe("priority");
    mode.stop(unsupported);
    expect(host.getStatus("fast")).toBeUndefined();
  });

  it("keeps runtime toggles independent and existing default bytes unchanged", async () => {
    const first = await setup();
    const text = '{"fast":true,"keep":"untouched"}';
    await writeFile(first.configPath, text);
    await first.mode.start(startup, first.ctx);
    const second = await setup();
    await second.mode.start(startup, second.ctx);
    first.mode.toggle("", first.ctx);
    expect(first.mode.payload(payload, first.ctx)).toBeUndefined();
    expect(second.mode.payload(payload, second.ctx)?.service_tier).toBe("priority");
    expect(await readFile(first.configPath, "utf8")).toBe(text);
    await first.mode.start(reload, first.ctx);
    expect(first.mode.payload(payload, first.ctx)?.service_tier).toBe("priority");
  });

  it("applies externally edited defaults only to new or reloaded runtimes", async () => {
    const first = await setup();
    await writeFile(first.configPath, '{"fast":false}');
    await first.mode.start(startup, first.ctx);
    await writeFile(first.configPath, '{"fast":true}');
    expect(first.mode.payload(payload, first.ctx)).toBeUndefined();
    const second = await setup();
    await second.mode.start(startup, second.ctx);
    expect(second.mode.payload(payload, second.ctx)?.service_tier).toBe("priority");
    await first.mode.start(reload, first.ctx);
    expect(first.mode.payload(payload, first.ctx)?.service_tier).toBe("priority");
    await writeFile(first.configPath, '{"fast":false}');
    expect(second.mode.payload(payload, second.ctx)?.service_tier).toBe("priority");
    await second.mode.start(reload, second.ctx);
    expect(second.mode.payload(payload, second.ctx)).toBeUndefined();
  });

  it("keeps --fast local, never saves it, and does not reapply it on reload", async () => {
    const first = await setup(true);
    await first.mode.start(startup, first.ctx);
    expect(first.mode.payload(payload, first.ctx)?.service_tier).toBe("priority");
    const second = await setup();
    const ctx = { ...second.ctx, hasUI: false };
    await second.mode.start(startup, ctx);
    expect(second.mode.payload(payload, ctx)).toBeUndefined();
    second.mode.toggle("", ctx);
    expect(second.mode.payload(payload, ctx)?.service_tier).toBe("priority");
    expect(second.host.getNotifications()).toStrictEqual([]);
    await first.mode.start(reload, first.ctx);
    expect(first.mode.payload(payload, first.ctx)).toBeUndefined();
    expect(await readdir(root)).toStrictEqual([]);
  });

  it.each([false, true])(
    "preserves malformed bytes and uses startup flag fallback %s",
    async (flag) => {
      const { mode, ctx, configPath, host } = await setup(flag);
      await writeFile(configPath, "broken");
      await mode.start(startup, ctx);
      expect(mode.payload(payload, ctx)?.service_tier).toBe(flag ? "priority" : undefined);
      expect(host.getNotifications().at(-1)?.type).toBe("warning");
      mode.toggle("", ctx);
      expect(await readFile(configPath, "utf8")).toBe("broken");
      await mode.start(reload, ctx);
      expect(mode.payload(payload, ctx)).toBeUndefined();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "ignores late load %s after shutdown",
    async (outcome) => {
      const loaded = Promise.withResolvers<boolean>();
      const { mode, ctx, host } = await setup(false, () => loaded.promise);
      const start = mode.start(startup, ctx);
      mode.stop(ctx);

      if (outcome === "resolve") loaded.resolve(true);
      else loaded.reject(new Error("Late read failure"));
      await start;
      mode.toggle("", ctx);
      await mode.start(startup, ctx);
      expect(mode.payload(payload, ctx)).toBeUndefined();
      expect(host.getStatus("fast")).toBeUndefined();
      expect(host.getNotifications()).toStrictEqual([]);
    },
  );
});
