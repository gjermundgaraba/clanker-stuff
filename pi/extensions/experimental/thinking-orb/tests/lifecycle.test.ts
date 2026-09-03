import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import type { OrbConfig } from "../config.js";
import type { OrbEnvironment } from "../ghostty.js";
import { createOrbLifecycle } from "../lifecycle.js";
import type { OverlayController, OverlayStatus } from "../overlay.js";

const readyEnvironment: Extract<OrbEnvironment, { kind: "ready" }> = {
  backingScale: 2,
  kind: "ready",
  settings: {
    customShaderAnimation: false,
    customShaderPath: "/shaders/thinking-orb-overlay.glsl",
    fontSizePt: 13,
    paddingXPt: 2,
    paddingYPt: 2,
  },
};

const makeController = (status: Partial<OverlayStatus> = {}) => {
  const controller: OverlayController = {
    start: vi.fn<() => void>(),
    status: () => ({
      frames: 12,
      lastError: undefined,
      layout: undefined,
      mode: "auto",
      running: true,
      waitingForDrain: false,
      ...status,
    }),
    stop: vi.fn<() => void>(),
  };
  return controller;
};

const makeConfig = (overrides: Partial<OrbConfig> = {}): OrbConfig => ({
  autoStart: true,
  enabled: true,
  fps: 60,
  version: 1,
  ...overrides,
});

const setup = (options: {
  config?: OrbConfig;
  environment?: OrbEnvironment;
  controller?: OverlayController;
  startError?: Error;
}) => {
  const controller =
    options.controller ?? makeController(options.startError ? {} : {});
  const start = controller.start as ReturnType<typeof vi.fn>;
  const { startError } = options;
  if (startError !== undefined) {
    start.mockImplementation(() => {
      throw startError;
    });
  }

  const host = createExtensionHost(() => {});
  const lifecycle = createOrbLifecycle({
    configStore: {
      load: async () => ({ config: options.config ?? makeConfig() }),
      path: "/tmp/thinking-orb.json",
      save: async () => {
        await Promise.resolve();
      },
    },
    controllerFactory: () => controller,
    environment: () => options.environment ?? readyEnvironment,
    stdout: { columns: 80, rows: 24 } as unknown as NodeJS.WriteStream,
  });
  return { controller, host, lifecycle };
};

describe(createOrbLifecycle, () => {
  it("auto-starts the overlay when the agent starts", async () => {
    const { host, lifecycle, controller } = setup({});
    const ctx = host.createContext();

    await lifecycle.onAgentStart(ctx);

    expect(controller.start).toHaveBeenCalledExactlyOnceWith("auto");
    expect(host.getNotifications()).toStrictEqual([]);
  });

  it("skips auto-start when disabled or not configured to auto-start", async () => {
    const { host, lifecycle, controller } = setup({
      config: makeConfig({ enabled: false }),
    });
    await lifecycle.onAgentStart(host.createContext());
    expect(controller.start).not.toHaveBeenCalled();

    const second = setup({ config: makeConfig({ autoStart: false }) });
    await second.lifecycle.onAgentStart(second.host.createContext());
    expect(second.controller.start).not.toHaveBeenCalled();
  });

  it("notifies an unsupported environment once per reason", async () => {
    const { host, lifecycle, controller } = setup({
      environment: {
        guidance: "run /orb-setup to install the shader",
        kind: "unsupported",
        reason: "Ghostty has no custom-shader configured",
      },
    });
    const ctx = host.createContext();

    await lifecycle.onAgentStart(ctx);
    await lifecycle.onAgentStart(ctx);

    const notifications = host.getNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.message).toContain("/orb-setup");
    expect(notifications[0]?.type).toBe("error");
    expect(controller.start).not.toHaveBeenCalled();
  });

  it("notifies and stops when starting the overlay throws", async () => {
    const { host, lifecycle, controller } = setup({
      startError: new Error("pane is 5000x5000px"),
    });
    await lifecycle.onAgentStart(host.createContext());

    expect(controller.stop).toHaveBeenCalledOnce();
    expect(host.getNotifications()[0]?.message).toContain("5000x5000");
  });

  it("does nothing outside TUI mode", async () => {
    const { host, lifecycle, controller } = setup({});
    const ctx = {
      ...host.createContext(),
      mode: "json" as const,
    };

    await lifecycle.onAgentStart(ctx);
    expect(controller.start).not.toHaveBeenCalled();
    expect(host.getNotifications()).toStrictEqual([]);
  });

  it("stops auto overlays on settle but keeps manual ones", async () => {
    const { host, lifecycle, controller } = setup({});
    const ctx = host.createContext();
    await lifecycle.onAgentStart(ctx);
    lifecycle.onAgentSettled();
    expect(controller.stop).toHaveBeenCalledOnce();

    const manual = setup({ controller: makeController({ mode: "manual" }) });
    await manual.lifecycle.onAgentStart(ctx);
    manual.lifecycle.onAgentSettled();
    expect(manual.controller.stop).not.toHaveBeenCalled();
  });

  it("starts manually and reports success", async () => {
    const { host, lifecycle, controller } = setup({});
    const ctx = host.createContext();
    await lifecycle.startManual(ctx);

    expect(controller.start).toHaveBeenCalledExactlyOnceWith("manual");
    expect(host.getNotifications()[0]?.message).toContain("started");
  });

  it("refuses manual start when disabled", async () => {
    const { host, lifecycle, controller } = setup({
      config: makeConfig({ enabled: false }),
    });
    await lifecycle.startManual(host.createContext());

    expect(controller.start).not.toHaveBeenCalled();
    expect(host.getNotifications()[0]?.message).toContain("disabled");
  });

  it("reports status with environment and overlay state", async () => {
    const { host, lifecycle } = setup({});
    const ctx = host.createContext();
    await lifecycle.onAgentStart(ctx);
    await lifecycle.status(ctx);

    const message = host.getNotifications().at(-1)?.message ?? "";
    expect(message).toContain("enabled=true");
    expect(message).toContain("backing scale 2");
    expect(message).toContain("running (auto, 12 frames)");
  });

  it("stops and clears the controller on shutdown", async () => {
    const { host, lifecycle, controller } = setup({});
    await lifecycle.onAgentStart(host.createContext());
    await lifecycle.onSessionShutdown();
    expect(controller.stop).toHaveBeenCalledOnce();
  });
});
