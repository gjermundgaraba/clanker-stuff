import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, decodeKittyPrintable, matchesKey } from "@earendil-works/pi-tui";

export const HELP_EDITOR = "Pi editor keybindings • Enter save • Esc discard";

export type DecodedIntent =
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "tab" }
  | { type: "shiftTab" }
  | { type: "space" }
  | { type: "printable"; text: string }
  | { type: "none" };

export type AskQuestionKeybindings = Pick<
  KeybindingsManager,
  "matches" | "getKeys"
>;

export const formatKeyLabel = (key: string): string => {
  switch (key) {
    case "enter":
    case "return": {
      return "Enter";
    }
    case "escape": {
      return "Esc";
    }
    case "space": {
      return "Space";
    }
    case "tab": {
      return "Tab";
    }
    case "up": {
      return "↑";
    }
    case "down": {
      return "↓";
    }
    case "left": {
      return "←";
    }
    case "right": {
      return "→";
    }
    case "pageUp": {
      return "PgUp";
    }
    case "pageDown": {
      return "PgDn";
    }
    default: {
      if (!key.includes("+")) {
        return key;
      }
      return key
        .split("+")
        .map((part) =>
          part.length === 1
            ? part.toUpperCase()
            : `${part[0].toUpperCase()}${part.slice(1)}`
        )
        .join("+");
    }
  }
};

const extractPrintableText = (data: string): string => {
  const kittyPrintable = decodeKittyPrintable(data);
  if (kittyPrintable !== undefined) {
    return kittyPrintable;
  }

  if (!data || data.includes("\u001B")) {
    return "";
  }

  let out = "";
  for (const char of data) {
    const code = char.codePointAt(0) ?? 0;
    const isControl =
      code < 32 || code === 127 || (code >= 0x80 && code <= 0x9f);
    if (!isControl) {
      out += char;
    }
  }
  return out;
};

export const isSingleCharShortcut = (
  intent: DecodedIntent,
  key: string
): boolean =>
  intent.type === "printable" &&
  intent.text.length === 1 &&
  intent.text.toLowerCase() === key.toLowerCase();

const formatBindingLabel = (
  keybindings: AskQuestionKeybindings,
  keybinding: Parameters<AskQuestionKeybindings["getKeys"]>[0],
  fallback: string
): string => {
  const keys = keybindings.getKeys(keybinding);
  if (keys.length === 0) {
    return fallback;
  }
  return keys.map(formatKeyLabel).join("/");
};

export const decodeAskQuestionIntent = (
  keybindings: AskQuestionKeybindings,
  data: string
): DecodedIntent => {
  type KeyId = Parameters<typeof matchesKey>[1];
  const match = (keyId: KeyId) => matchesKey(data, keyId);

  if (keybindings.matches(data, "tui.select.confirm")) {
    return { type: "confirm" };
  }
  if (keybindings.matches(data, "tui.select.cancel")) {
    return { type: "cancel" };
  }
  if (keybindings.matches(data, "tui.select.up")) {
    return { type: "up" };
  }
  if (keybindings.matches(data, "tui.select.down")) {
    return { type: "down" };
  }
  if (match(Key.left)) {
    return { type: "left" };
  }
  if (match(Key.right)) {
    return { type: "right" };
  }
  if (match(Key.tab)) {
    return { type: "tab" };
  }
  if (match(Key.shift(Key.tab))) {
    return { type: "shiftTab" };
  }
  if (match(Key.space)) {
    return { type: "space" };
  }

  const printable = extractPrintableText(data);
  if (printable.length > 0) {
    return { text: printable, type: "printable" };
  }
  return { type: "none" };
};

export const createHelpText = (keybindings: AskQuestionKeybindings) => {
  const confirm = formatBindingLabel(
    keybindings,
    "tui.select.confirm",
    "confirm"
  );
  const cancel = formatBindingLabel(keybindings, "tui.select.cancel", "cancel");
  const up = formatBindingLabel(keybindings, "tui.select.up", "↑");
  const down = formatBindingLabel(keybindings, "tui.select.down", "↓");
  const move = `${up}/${down}`;

  return {
    cancel,
    confirm,
    freeText: `${confirm} edit answer`,
    globalTabs: `Tab/Shift+Tab or ←→ tabs • ${cancel} cancel questionnaire`,
    move,
    multi: `${move} move • Space toggle • ${confirm} confirm • n note`,
    multiOther: `${move} move • Space/${confirm} edit Other`,
    single: `${move} move • ${confirm} select • n note`,
    singleOther: `${move} move • ${confirm} edit Other`,
    submit: `${confirm} submit`,
  };
};

export type HelpText = ReturnType<typeof createHelpText>;
