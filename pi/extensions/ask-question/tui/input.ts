import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, matchesKey } from "@earendil-works/pi-tui";
export type Keys = Pick<KeybindingsManager, "matches" | "getKeys">;
export function keyLabel(keys: Keys, action: Parameters<Keys["getKeys"]>[0]): string {
  return keys.getKeys(action).join("/") || action.split(".").at(-1)!;
}
export type Intent =
  | "confirm"
  | "close"
  | "up"
  | "down"
  | "back"
  | "next"
  | "page_up"
  | "page_down"
  | "toggle"
  | "none"
  | `key:${string}`;
export function intent(keys: Keys, data: string, vimNavigation = false): Intent {
  if (keys.matches(data, "tui.select.cancel")) return "close";
  if (keys.matches(data, "tui.select.confirm")) return "confirm";
  if (keys.matches(data, "tui.select.up")) return "up";
  if (keys.matches(data, "tui.select.down")) return "down";
  if (keys.matches(data, "tui.select.pageUp")) return "page_up";
  if (keys.matches(data, "tui.select.pageDown")) return "page_down";
  if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) return "back";
  if (matchesKey(data, "right") || keys.matches(data, "tui.input.tab")) return "next";
  if (matchesKey(data, "space")) return "toggle";
  const printable = decodeKittyPrintable(data) ?? data;
  if (printable === "h") return "back";
  if (printable === "l") return "next";
  if (vimNavigation && printable === "j") return "down";
  if (vimNavigation && printable === "k") return "up";
  return /^[a-zA-Z1-5]$/.test(printable) ? `key:${printable.toLowerCase()}` : "none";
}
