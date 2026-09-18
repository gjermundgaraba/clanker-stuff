import { randomUUID } from "node:crypto";
import {
  BORDER_READY_EVENT,
  BORDER_READY_REQUEST_EVENT,
  BORDER_STATUS_EVENT,
  BORDER_UNAVAILABLE_EVENT,
  BorderReadyRequestSchema,
  BorderUpdateSchema,
  borderScope,
} from "@clanker-stuff/border-status-protocol";
import type { IconFamily } from "@clanker-stuff/status-icons";
import type { BorderReady } from "@clanker-stuff/border-status-protocol";
import {
  FOOTER_PROTOCOL_VERSION,
  FOOTER_ICON_PREFERENCE_EVENT,
  FOOTER_ICON_PREFERENCE_REQUEST_EVENT,
  FooterIconPreferenceSchema,
} from "@clanker-stuff/footer-protocol";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  ConfigSchema,
  defaultConfig,
  loadConfig,
  loadFooterPreference,
  saveConfig,
} from "./config.js";
import { installBorderEditor } from "./editor.js";
import { renderBorder } from "./layout.js";
import type { StatusEntry } from "./layout.js";

export function createBorderHost(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let ready: BorderReady | undefined;
  let config = { ...defaultConfig };
  let family: IconFamily = "unicode";
  let mounted = false;
  let generation = 0;
  let requestRender = () => {};

  let detachEditor: (() => void) | undefined;
  let unsubscribe: (() => void)[] = [];
  const entries = new Map<string, StatusEntry>();

  const emitReady = () => {
    if (ready && mounted) pi.events.emit(BORDER_READY_EVENT, ready);
  };

  const reset = () => {
    if (ready) pi.events.emit(BORDER_UNAVAILABLE_EVENT, ready);
    ready = undefined;
    entries.clear();
    requestRender();
  };

  const navigate = (next: ExtensionContext, navigationId: string | null = null) => {
    reset();
    ctx = next;

    if (next.mode !== "tui") return;
    ready = { version: 1, instanceId: randomUUID(), scope: borderScope(next, navigationId) };
    emitReady();
  };

  const shutdown = () => {
    generation++;
    reset();
    detachEditor?.();
    detachEditor = undefined;

    for (const stop of unsubscribe) stop();
    unsubscribe = [];
    ctx = undefined;
    mounted = false;
    requestRender = () => {};
  };

  return {
    navigate,
    shutdown,
    async start(next: ExtensionContext) {
      shutdown();

      if (next.mode !== "tui") return;
      const epoch = generation;
      const [loaded, inherited] = await Promise.all([loadConfig(), loadFooterPreference()]);

      if (epoch !== generation) return;
      config = loaded;
      family = inherited;
      navigate(next);
      unsubscribe = [
        pi.events.on(BORDER_STATUS_EVENT, (value) => {
          if (
            !Value.Check(BorderUpdateSchema, value) ||
            !ready ||
            value.instanceId !== ready.instanceId ||
            value.scope !== ready.scope
          )
            return;
          const key = value.type === "clear-owner" ? "" : JSON.stringify([value.owner, value.key]);

          if (value.type === "set") {
            entries.set(key, {
              owner: value.owner,
              key: value.key,
              status: structuredClone(value.status),
            });
          } else if (value.type === "clear") entries.delete(key);
          else
            for (const [id, entry] of entries) if (entry.owner === value.owner) entries.delete(id);
          requestRender();
        }),
        pi.events.on(BORDER_READY_REQUEST_EVENT, (value) => {
          if (Value.Check(BorderReadyRequestSchema, value)) emitReady();
        }),
        pi.events.on(FOOTER_ICON_PREFERENCE_EVENT, (value) => {
          if (!Value.Check(FooterIconPreferenceSchema, value)) return;
          family = value.iconFamily;
          requestRender();
        }),
      ];
      pi.events.emit(FOOTER_ICON_PREFERENCE_REQUEST_EVENT, {
        protocol: FOOTER_PROTOCOL_VERSION,
        type: "icon-preference-request",
      });
      detachEditor = installBorderEditor(next, {
        mounted: (render) => {
          requestRender = render;
          mounted = true;
          emitReady();
        },
        render: (line, width, color) =>
          ctx && ready
            ? renderBorder(
                line,
                width,
                [...entries.values()],
                config.iconFamily === "inherit" ? family : config.iconFamily,
                ctx.ui.theme,
                color,
              )
            : line,
      });
    },
    async command(args: string, context: ExtensionContext) {
      if (context.mode !== "tui" || !ready) {
        context.ui.notify("Border status requires an active TUI session", "warning");

        return;
      }

      const parts = args.trim().split(/\s+/);
      const candidate = { version: 1, iconFamily: parts[1] };

      if (parts.length !== 2 || parts[0] !== "icons" || !Value.Check(ConfigSchema, candidate)) {
        context.ui.notify(
          `Border icons: ${config.iconFamily} (effective: ${config.iconFamily === "inherit" ? family : config.iconFamily}). Usage: /border-status icons inherit|nerd|unicode|ascii`,
          "info",
        );

        return;
      }

      const epoch = generation;
      await saveConfig(candidate);

      if (epoch !== generation) return;
      config = candidate;
      requestRender();
    },
  };
}
