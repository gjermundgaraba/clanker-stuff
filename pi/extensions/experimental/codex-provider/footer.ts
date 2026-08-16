import {
  FOOTER_PROTOCOL_VERSION,
  FOOTER_READY_EVENT,
  FOOTER_READY_REQUEST_EVENT,
  FOOTER_WIDGET_EVENT,
  isFooterReadyMessage,
} from "@clanker-stuff/footer-protocol";
import type { FooterWidgetSnapshot } from "@clanker-stuff/footer-protocol";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CODE_MODE_STATUS_KEY = "codex-code-mode";
export const FAST_MODE_STATUS_KEY = "codex-fast";

const WIDGETS = {
  codeMode: {
    consumesStatusKeys: [CODE_MODE_STATUS_KEY],
    content: [{ text: "code", tone: "accent" }],
    defaults: { enabled: true },
    icon: {
      glyphs: { ascii: "</>", nerd: "󰅩", unicode: "</>" },
      tone: "accent",
    },
    id: "clanker.codex.code-mode",
    label: "Codex Code Mode",
  },
  fastMode: {
    consumesStatusKeys: [FAST_MODE_STATUS_KEY],
    content: [{ text: "fast", tone: "warning" }],
    defaults: { enabled: true },
    icon: {
      glyphs: { ascii: ">>", nerd: "󱐋", unicode: "⚡" },
      tone: "warning",
    },
    id: "clanker.codex.fast",
    label: "Codex fast mode",
  },
} as const satisfies Record<string, FooterWidgetSnapshot>;

type WidgetName = keyof typeof WIDGETS;

export const createCodexFooter = (pi: ExtensionAPI) => {
  const active = new Set<WidgetName>();
  let instanceId: string | undefined;

  const emit = (name: WidgetName, enabled: boolean): void => {
    if (instanceId === undefined) {
      return;
    }
    const widget = WIDGETS[name];
    const envelope = { instanceId, protocol: FOOTER_PROTOCOL_VERSION };
    pi.events.emit(
      FOOTER_WIDGET_EVENT,
      enabled
        ? {
            ...envelope,
            type: "upsert",
            widget,
          }
        : {
            ...envelope,
            id: widget.id,
            type: "remove",
          }
    );
  };

  const setActive = (name: WidgetName, enabled: boolean): void => {
    if (active.has(name) === enabled) {
      return;
    }
    if (enabled) {
      active.add(name);
    } else {
      active.delete(name);
    }
    emit(name, enabled);
  };

  const readyUnsubscribe = pi.events.on(FOOTER_READY_EVENT, (value) => {
    if (!isFooterReadyMessage(value)) {
      return;
    }
    const { instanceId: readyInstanceId } = value;
    instanceId = readyInstanceId;
    for (const name of active) {
      emit(name, true);
    }
  });
  pi.events.emit(FOOTER_READY_REQUEST_EVENT, {
    protocol: FOOTER_PROTOCOL_VERSION,
    type: "ready-request",
  });

  return {
    dispose(): void {
      for (const name of active) {
        emit(name, false);
      }
      active.clear();
      instanceId = undefined;
      readyUnsubscribe();
    },
    setCodeMode: (enabled: boolean): void => setActive("codeMode", enabled),
    setFastMode: (enabled: boolean): void => setActive("fastMode", enabled),
  };
};
