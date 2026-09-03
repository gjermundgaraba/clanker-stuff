/**
 * Orb lifecycle glue: probes the environment, applies configuration, drives
 * the overlay controller from agent events, and reports human-readable status.
 */

import { execFileSync } from "node:child_process";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCellDimensions } from "@earendil-works/pi-tui";

import { createOrbConfigStore } from "./config.js";
import type { LoadedOrbConfig, OrbConfig, OrbConfigStore } from "./config.js";
import { probeOrbEnvironment } from "./ghostty.js";
import type { OrbEnvironment } from "./ghostty.js";
import { resolveLayout } from "./layout.js";
import { createOverlayController } from "./overlay.js";
import type { OverlayController, OverlayMode } from "./overlay.js";
import { installOrbShader } from "./setup.js";

export interface OrbLifecycleDeps {
  configStore?: OrbConfigStore;
  controllerFactory?: (
    config: OrbConfig,
    environment: Extract<OrbEnvironment, { kind: "ready" }>
  ) => OverlayController;
  environment?: () => OrbEnvironment;
  stdout?: NodeJS.WriteStream;
}

const notifyError = (ctx: ExtensionContext, message: string): void => {
  ctx.ui.notify(message, "error");
};

const environmentSummary = (
  environment: OrbEnvironment,
  loaded: LoadedOrbConfig,
  configPath: string
): string[] => {
  const lines: string[] = [
    `config: ${configPath}`,
    `config values: enabled=${loaded.config.enabled} autoStart=${loaded.config.autoStart} fps=${loaded.config.fps}${
      loaded.config.backingScale === undefined
        ? ""
        : ` backingScale=${loaded.config.backingScale}`
    }`,
  ];
  if (loaded.error !== undefined) {
    lines.push(`config warning: ${loaded.error}`);
  }
  if (environment.kind === "ready") {
    lines.push(
      `environment: Ghostty ready (backing scale ${environment.backingScale})`,
      `shader: ${environment.settings.customShaderPath}`
    );
  } else {
    lines.push(`environment: ${environment.reason}`);
    if (environment.guidance !== undefined) {
      lines.push(`fix: ${environment.guidance}`);
    }
  }
  return lines;
};

export const createOrbLifecycle = (deps: OrbLifecycleDeps = {}) => {
  const configStore = deps.configStore ?? createOrbConfigStore();
  const stdout = deps.stdout ?? process.stdout;
  const probe =
    deps.environment ??
    (() =>
      probeOrbEnvironment({
        cellWidthPx: getCellDimensions().widthPx,
        env: process.env,
        platform: process.platform,
        showConfig: () =>
          execFileSync("ghostty", ["+show-config"], {
            encoding: "utf-8",
            timeout: 1000,
          }),
      }));

  let controller: OverlayController | undefined;
  const notifiedReasons = new Set<string>();

  const startOverlay = async (
    ctx: ExtensionContext,
    mode: OverlayMode,
    config: OrbConfig
  ): Promise<boolean> => {
    const environment = probe();
    if (environment.kind === "unsupported") {
      if (!notifiedReasons.has(environment.reason)) {
        notifiedReasons.add(environment.reason);
        const guidance =
          environment.guidance === undefined ? "" : ` ${environment.guidance}.`;
        notifyError(
          ctx,
          `Thinking Orb unavailable: ${environment.reason}.${guidance}`
        );
      }
      return false;
    }

    const factory =
      deps.controllerFactory ??
      ((orbConfig, ready) =>
        createOverlayController({
          fps: orbConfig.fps,
          layout: () =>
            resolveLayout(
              { stream: stdout },
              {
                backingScale: ready.backingScale,
                paddingXPt: ready.settings.paddingXPt,
                paddingYPt: ready.settings.paddingYPt,
              }
            ),
          metrics: () => {
            const cell = getCellDimensions();
            return {
              cellHeightPx: cell.heightPx,
              cellWidthPx: cell.widthPx,
              columns: stdout.columns ?? 80,
              rows: stdout.rows ?? 24,
            };
          },
          out: stdout,
        }));
    controller = factory(config, environment);
    try {
      controller.start(mode);
    } catch (error) {
      controller.stop();
      controller = undefined;
      notifyError(
        ctx,
        `Could not start the Thinking Orb: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return false;
    }
    return true;
  };

  return {
    onAgentSettled(): void {
      const status = controller?.status();
      if (status?.running === true && status.mode === "auto") {
        controller?.stop();
      }
    },

    async onAgentStart(ctx: ExtensionContext): Promise<void> {
      if (ctx.mode !== "tui" || controller?.status().running === true) {
        return;
      }

      const loaded = await configStore.load();
      if (!loaded.config.enabled || !loaded.config.autoStart) {
        return;
      }
      await startOverlay(ctx, "auto", loaded.config);
    },

    async onSessionShutdown(): Promise<void> {
      controller?.stop();
      controller = undefined;
    },

    async setup(ctx: ExtensionContext): Promise<void> {
      const result = await installOrbShader({
        confirm: (title, body) => ctx.ui.confirm(title, body),
      });
      const lines: string[] = [
        `shader: ${result.shaderPath}`,
        result.shaderUpdated
          ? "shader installed (replaced an older copy)"
          : "shader already up to date",
      ];
      if (result.configUpdated) {
        lines.push(
          `config updated: ${result.configPath}`,
          "restart Ghostty to activate the overlay"
        );
      } else if (result.declined) {
        lines.push(
          `config not updated; add custom-shader = ${result.shaderPath} and custom-shader-animation = false to ${result.configPath}`
        );
      } else {
        lines.push(
          `config already references the shader: ${result.configPath}`
        );
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },

    async startManual(ctx: ExtensionContext): Promise<void> {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        notifyError(ctx, "The Thinking Orb requires Ghostty's TUI.");
        return;
      }

      const loaded = await configStore.load();
      if (!loaded.config.enabled) {
        notifyError(
          ctx,
          `The Thinking Orb is disabled; set enabled = true in ${configStore.path}.`
        );
        return;
      }

      const started = await startOverlay(ctx, "manual", loaded.config);
      if (started) {
        ctx.ui.notify("Thinking Orb started.", "info");
      }
    },

    async status(ctx: ExtensionContext): Promise<void> {
      const loaded = await configStore.load();
      const lines = environmentSummary(probe(), loaded, configStore.path);
      const overlayStatus = controller?.status();
      if (overlayStatus) {
        let overlay = "stopped";
        if (overlayStatus.running) {
          overlay = `running (${overlayStatus.mode}, ${overlayStatus.frames} frames)`;
        } else if (overlayStatus.lastError !== undefined) {
          overlay = `stopped after error: ${overlayStatus.lastError}`;
        }
        lines.push(`overlay: ${overlay}`);
        if (overlayStatus.layout) {
          const { layout } = overlayStatus;
          lines.push(
            `layout: ${layout.columns}x${layout.rows} cells, ${layout.pixelWidth}x${layout.pixelHeight}px, phase ${layout.phaseX},${layout.phaseY}`
          );
        }
        if (overlayStatus.waitingForDrain) {
          lines.push("backpressure: waiting for the PTY to drain");
        }
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },

    async stopManual(ctx: ExtensionContext): Promise<void> {
      controller?.stop();
      controller = undefined;
      ctx.ui.notify("Thinking Orb stopped.", "info");
    },
  };
};

export type OrbLifecycle = ReturnType<typeof createOrbLifecycle>;
