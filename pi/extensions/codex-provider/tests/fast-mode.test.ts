import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { createFastModeState } from "../fast-mode.js";
import extension from "../index.js";
import { SPIKE_MODEL } from "./fixtures.js";

const FAST_MODEL = { ...SPIKE_MODEL, id: "gpt-5.6-sol", name: "GPT-5.6 Sol" };

describe("Codex fast mode", () => {
  let agentDir: string;
  let tempRoot: string;

  const createHost = (flags?: Record<string, boolean | string>) =>
    createExtensionHost(
      (pi) => {
        Object.assign(pi, {
          registerEntryRenderer: vi.fn<() => void>(),
          registerProvider: vi.fn<() => void>(),
        });
        extension(pi);
      },
      { flags, model: FAST_MODEL }
    );

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "codex-fast-"));
    agentDir = path.join(tempRoot, "agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  });

  afterEach(() => {
    rmSync(tempRoot, { force: true, recursive: true });
    vi.unstubAllEnvs();
  });

  it("persists toggles globally and hides status for unsupported models", async () => {
    const first = createHost();
    const firstContext = first.createContext();

    await first.emitSessionStart(firstContext);
    await first.runCommand("fast", "", firstContext);
    expect({
      config: JSON.parse(
        readFileSync(path.join(agentDir, "codex-provider.json"), "utf-8")
      ),
      status: first.getStatus("codex-fast"),
    }).toStrictEqual({ config: { fast: true }, status: "⚡" });

    await first.emit(
      "model_select",
      {
        model: SPIKE_MODEL,
        previousModel: FAST_MODEL,
        source: "set",
        type: "model_select",
      },
      first.createContext({ model: SPIKE_MODEL })
    );
    expect(first.getStatus("codex-fast")).toBeUndefined();

    const second = createHost();
    const secondContext = second.createContext();
    await second.emitSessionStart(secondContext);
    expect(second.getStatus("codex-fast")).toBe("⚡");

    await second.runCommand("fast", "", secondContext);
    expect({
      config: JSON.parse(
        readFileSync(path.join(agentDir, "codex-provider.json"), "utf-8")
      ),
      status: second.getStatus("codex-fast"),
    }).toStrictEqual({
      config: { fast: false },
      status: undefined,
    });
  });

  it("uses --fast only for the initial session", async () => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      path.join(agentDir, "codex-provider.json"),
      '{ "fast": false }\n'
    );
    const host = createHost({ fast: true });
    const ctx = host.createContext();

    await host.emitSessionStart(ctx);
    expect(host.getStatus("codex-fast")).toBe("⚡");

    await host.emitSessionStart(ctx, "new");
    expect(host.getStatus("codex-fast")).toBeUndefined();
  });

  it("keeps a pre-load /fast opt-out after the lifecycle loads", async () => {
    const host = createHost({ fast: true });
    const ctx = host.createContext();

    await host.emitSessionStart(ctx);
    await host.runCommand("fast", "", ctx);
    expect(host.getStatus("codex-fast")).toBeUndefined();

    await host.runCommand("codex-provider", "", ctx);

    expect(host.getStatus("codex-fast")).toBeUndefined();
    expect(
      JSON.parse(
        readFileSync(path.join(agentDir, "codex-provider.json"), "utf-8")
      )
    ).toStrictEqual({ fast: false });
  });

  it("serializes startup loading before toggles", async () => {
    const loading = Promise.withResolvers<boolean>();
    const save = vi.fn<(enabled: boolean) => Promise<void>>(
      async () => await Promise.resolve()
    );
    let api: ExtensionAPI | undefined;
    const host = createExtensionHost((pi) => {
      api = pi;
    });
    if (api === undefined) {
      throw new Error("Extension API was not initialized");
    }
    const state = createFastModeState(api, {
      load: () => loading.promise,
      path: "test-fast.json",
      save,
    });
    const ctx = host.createContext();

    const start = state.start(ctx, false);
    const toggle = state.toggle(ctx);
    expect(save).not.toHaveBeenCalled();

    loading.resolve(true);
    await Promise.all([start, toggle]);

    expect({
      enabled: state.isEnabled(),
      notifications: host.getNotifications(),
      saves: save.mock.calls,
    }).toStrictEqual({
      enabled: false,
      notifications: [{ message: "Codex fast mode disabled", type: undefined }],
      saves: [[false]],
    });
  });

  it("does not update state or UI when shutdown wins an in-flight operation", async () => {
    const loading = Promise.withResolvers<boolean>();
    const saving = Promise.withResolvers<null>();
    const load = vi.fn<() => Promise<boolean>>(() => loading.promise);
    const save = vi.fn<(enabled: boolean) => Promise<void>>(async () => {
      await saving.promise;
    });
    let api: ExtensionAPI | undefined;
    const host = createExtensionHost((pi) => {
      api = pi;
    });
    if (api === undefined) {
      throw new Error("Extension API was not initialized");
    }
    const state = createFastModeState(api, {
      load,
      path: "test-fast.json",
      save,
    });
    const ctx = host.createContext();

    const start = state.start(ctx, false);
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledOnce();
    });
    state.stop();
    loading.reject(new Error("late load failure"));
    await start;

    expect({
      enabled: state.isEnabled(),
      notifications: host.getNotifications(),
      saves: save.mock.calls,
    }).toStrictEqual({
      enabled: false,
      notifications: [],
      saves: [],
    });
  });

  it("does not commit an in-flight toggle after shutdown", async () => {
    const saving = Promise.withResolvers<null>();
    const save = vi.fn<(enabled: boolean) => Promise<void>>(async () => {
      await saving.promise;
    });
    let api: ExtensionAPI | undefined;
    const host = createExtensionHost((pi) => {
      api = pi;
    });
    if (api === undefined) {
      throw new Error("Extension API was not initialized");
    }
    const state = createFastModeState(api, {
      load: async () => false,
      path: "test-fast.json",
      save,
    });
    const ctx = host.createContext();

    const toggle = state.toggle(ctx);
    await vi.waitFor(() => {
      expect(save).toHaveBeenCalledWith(true);
    });
    state.stop();
    saving.resolve(null);
    await toggle;

    expect({
      enabled: state.isEnabled(),
      notifications: host.getNotifications(),
    }).toStrictEqual({ enabled: false, notifications: [] });
  });
});
