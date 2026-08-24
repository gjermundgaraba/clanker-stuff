import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  SelectList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { SelectItem } from "@earendil-works/pi-tui";

import { cloneFooterConfig, DEFAULT_CONFIG } from "./config.js";
import type { FooterConfig, LoadedFooterConfig } from "./config.js";
import type { FooterSource } from "./widgets.js";

const GROUPS = ["left", "center", "right"] as const;
const ICONS: FooterConfig["iconFamily"][] = ["ascii", "unicode", "nerd"];
const PREVIEW_WIDTHS = ["current", "80", "40"] as const;
type AggregateId = "footer.statuses" | "footer.widgets";
type Group = (typeof GROUPS)[number];
export interface FooterEditorWidget {
  defaultEnabled?: boolean;
  id: string;
  label: string;
  source?: FooterSource;
}

export interface FooterEditorOptions {
  loaded: LoadedFooterConfig;
  widgets: readonly FooterEditorWidget[];
  onPreview: (config: FooterConfig) => void;
  onSave: (config: FooterConfig) => Promise<void>;
  renderPreview: (config: FooterConfig, width: number) => string[];
}

type FooterUiContext = {
  ui: Pick<ExtensionCommandContext["ui"], "custom">;
};

type Chip = {
  group: Group;
  index: number;
  row: number;
} & (
  | {
      aggregate?: never;
      id: string;
      kind: "add";
    }
  | {
      aggregate?: AggregateId;
      id: string;
      kind: "placed";
    }
  | {
      aggregate?: never;
      id: string;
      kind: "waiting";
    }
);

interface PickerItem {
  available: boolean;
  id: string;
  label: string;
}

const sameConfig = (left: FooterConfig, right: FooterConfig): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const directIds = (config: FooterConfig): Set<string> =>
  new Set(
    config.rows.flatMap((row) =>
      GROUPS.flatMap((group) =>
        row[group].filter((id) => id !== "footer.widgets" && id !== "footer.statuses"),
      ),
    ),
  );

const sourceAggregate = (widget: FooterEditorWidget): AggregateId | undefined =>
  widget.source === "rich"
    ? "footer.widgets"
    : widget.source === "native"
      ? "footer.statuses"
      : undefined;

const chipsFor = (config: FooterConfig, widgets: readonly FooterEditorWidget[]): Chip[] => {
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  const explicit = directIds(config);
  const chips: Chip[] = [];
  const represented = new Set<string>();

  config.rows.forEach((row, rowIndex) => {
    for (const group of GROUPS) {
      row[group].forEach((id, index) => {
        if (id === "footer.widgets" || id === "footer.statuses") {
          chips.push({
            group,
            id,
            index,
            kind: "placed",
            row: rowIndex,
          });
          const members = widgets
            .filter((widget) => sourceAggregate(widget) === id && !explicit.has(widget.id))
            .toSorted((left, right) => left.id.localeCompare(right.id));
          for (const member of members) {
            represented.add(member.id);
            const enabled = config.widgets[member.id]?.enabled ?? member.defaultEnabled ?? true;
            if (enabled) {
              chips.push({
                aggregate: id,
                group,
                id: member.id,
                index,
                kind: "placed",
                row: rowIndex,
              });
            }
          }
          return;
        }
        if (represented.has(id)) {
          return;
        }
        represented.add(id);
        const enabled = config.widgets[id]?.enabled ?? byId.get(id)?.defaultEnabled ?? true;
        if (enabled) {
          chips.push({
            group,
            id,
            index,
            kind: byId.has(id) ? "placed" : "waiting",
            row: rowIndex,
          });
        }
      });
      chips.push({
        group,
        id: `add:${rowIndex}:${group}`,
        index: row[group].length,
        kind: "add",
        row: rowIndex,
      });
    }
  });
  return chips;
};

const pickerItems = (
  config: FooterConfig,
  widgets: readonly FooterEditorWidget[],
  chips: readonly Chip[],
): PickerItem[] => {
  const placed = new Set(chips.filter((chip) => chip.kind !== "add").map((chip) => chip.id));
  const live = new Map(widgets.map((widget) => [widget.id, widget]));
  return [...new Set([...widgets.map((widget) => widget.id), ...Object.keys(config.widgets)])]
    .filter((id) => !placed.has(id))
    .map((id) => ({
      available: live.has(id),
      id,
      label: live.get(id)?.label ?? id,
    }))
    .toSorted((left, right) => left.label.localeCompare(right.label));
};

const ensureOverride = (
  config: FooterConfig,
  id: string,
): NonNullable<FooterConfig["widgets"][string]> => {
  const current = config.widgets[id];
  if (current !== undefined) {
    return current;
  }
  const created = {};
  config.widgets[id] = created;
  return created;
};

const removeDirectPlacement = (config: FooterConfig, id: string): void => {
  for (const row of config.rows) {
    for (const group of GROUPS) {
      row[group] = row[group].filter((candidate) => candidate !== id);
    }
  }
};

const place = (
  config: FooterConfig,
  id: string,
  row: number,
  group: (typeof GROUPS)[number],
  index: number,
): void => {
  removeDirectPlacement(config, id);
  const target = config.rows[row]?.[group];
  if (target !== undefined) {
    target.splice(Math.max(0, Math.min(index, target.length)), 0, id);
  }
  ensureOverride(config, id).enabled = true;
};

const direction = (
  data: string,
  keybindings?: Pick<KeybindingsManager, "matches">,
): "down" | "left" | "right" | "up" | undefined =>
  keybindings?.matches(data, "tui.select.down") === true ||
  matchesKey(data, Key.down) ||
  data === "j"
    ? "down"
    : keybindings?.matches(data, "tui.select.up") === true ||
        matchesKey(data, Key.up) ||
        data === "k"
      ? "up"
      : matchesKey(data, Key.left) || data === "h"
        ? "left"
        : matchesKey(data, Key.right) || data === "l"
          ? "right"
          : undefined;

const isApply = (data: string, keybindings?: Pick<KeybindingsManager, "matches">): boolean =>
  keybindings?.matches(data, "tui.select.confirm") === true ||
  matchesKey(data, Key.enter) ||
  matchesKey(data, Key.space);

const line = (text: string, width: number): string =>
  truncateToWidth(text, Math.max(1, width), "…");

const padLine = (text: string, width: number): string => {
  const clipped = line(text, width);
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
};

const aligned = (left: string, right: string, width: number): string => {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap > 0 ? `${left}${" ".repeat(gap)}${right}` : line(`${left} ${right}`, width);
};

const safeInline = (value: string): string => {
  let result = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    result += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : char;
  }
  return result;
};

const wrapSegments = (prefix: string, segments: readonly string[], width: number): string[] => {
  if (segments.length === 0) {
    return [prefix];
  }
  const indentation = " ".repeat(visibleWidth(prefix));
  const lines: string[] = [];
  let current = prefix;
  for (const segment of segments) {
    const separator = visibleWidth(current) > visibleWidth(prefix) ? " " : "";
    if (
      visibleWidth(current) > visibleWidth(prefix) &&
      visibleWidth(`${current}${separator}${segment}`) > width
    ) {
      lines.push(current);
      current = `${indentation}${segment}`;
    } else {
      current += `${separator}${segment}`;
    }
  }
  lines.push(current);
  return lines;
};

const joinColumns = (columns: readonly string[][], width: number): string[] => {
  const gap = 2;
  const available = Math.max(1, width - gap * (columns.length - 1));
  const base = Math.floor(available / columns.length);
  const widths = columns.map((_column, index) =>
    index === columns.length - 1 ? available - base * (columns.length - 1) : base,
  );
  const height = Math.max(...columns.map((column) => column.length));
  return Array.from({ length: height }, (_value, lineIndex) =>
    columns
      .map((column, columnIndex) => padLine(column[lineIndex] ?? "", widths[columnIndex] ?? 1))
      .join(" ".repeat(gap)),
  );
};

export class FooterEditor {
  private readonly done: (value: null) => void;
  private readonly options: FooterEditorOptions;
  private readonly keybindings?: Pick<KeybindingsManager, "matches">;
  private readonly theme: Theme;
  private readonly requestRender: () => void;
  private original: FooterConfig;
  private working: FooterConfig;
  private selected = 0;
  private previewWidth = 0;
  private picker?: {
    group: (typeof GROUPS)[number];
    items: SelectItem[];
    list: SelectList;
    row: number;
  };
  private grabbed?: { backup: FooterConfig; id: string };
  private invalidConfirmation = false;
  private sourceInvalid: boolean;
  private status = "";
  private saveQueue = Promise.resolve();
  private saveVersion = 0;

  constructor(
    theme: Theme,
    requestRender: () => void,
    done: (value: null) => void,
    options: FooterEditorOptions,
    keybindings?: Pick<KeybindingsManager, "matches">,
  ) {
    this.theme = theme;
    this.requestRender = requestRender;
    this.done = done;
    this.options = options;
    this.keybindings = keybindings;
    this.original = cloneFooterConfig(options.loaded.config);
    this.working = cloneFooterConfig(options.loaded.config);
    this.sourceInvalid = options.loaded.error !== undefined && options.loaded.error.length > 0;
  }

  invalidate(): void {
    this.requestRender();
  }

  dispose(): void {
    // No editor-owned subscriptions.
  }

  handleInput(data: string): void {
    if (this.picker !== undefined) {
      this.handlePicker(data);
      this.requestRender();
      return;
    }
    if (
      this.keybindings?.matches(data, "tui.select.cancel") === true ||
      matchesKey(data, Key.escape)
    ) {
      if (this.grabbed) {
        this.working = this.grabbed.backup;
        this.grabbed = undefined;
        this.changed();
      } else {
        this.requestClose();
      }
      return;
    }
    const movement = direction(data, this.keybindings);
    const apply = isApply(data, this.keybindings);
    if (movement !== undefined || apply) {
      this.handleLayout(data, movement, apply);
      this.requestRender();
      return;
    }
    if (this.grabbed === undefined && this.handleShortcut(data)) {
      this.requestRender();
      return;
    }

    this.handleLayout(data, undefined, false);
    this.requestRender();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    const chips = this.chips();
    const requestedPreview =
      PREVIEW_WIDTHS[this.previewWidth] === "current"
        ? innerWidth
        : Number(PREVIEW_WIDTHS[this.previewWidth]);
    const preview = Math.min(innerWidth, requestedPreview);
    const dirty = !sameConfig(this.working, this.original);
    const rows: string[] = [
      aligned(
        this.theme.fg("accent", this.theme.bold("Footer layout")),
        dirty ? this.theme.fg("warning", "● unsaved") : this.theme.fg("dim", "saved"),
        innerWidth,
      ),
      this.sourceInvalid &&
      this.options.loaded.error !== undefined &&
      this.options.loaded.error.length > 0
        ? this.theme.fg("error", safeInline(this.options.loaded.error))
        : this.theme.fg("dim", "Global · footer.json"),
      "",
    ];

    for (let rowIndex = 0; rowIndex < this.working.rows.length; rowIndex += 1) {
      rows.push(
        ...this.renderLayoutRow(rowIndex, chips, innerWidth),
        ...(rowIndex === this.working.rows.length - 1 ? [] : [""]),
      );
    }
    rows.push(
      "",
      ...this.renderPicker(innerWidth),
      ...(this.picker === undefined ? [] : [""]),
      this.divider(
        `Live preview · ${PREVIEW_WIDTHS[this.previewWidth]}${this.working.enabled ? "" : " · built-in footer"}`,
        innerWidth,
      ),
      ...(this.working.enabled
        ? this.options.renderPreview(this.working, Math.max(1, preview))
        : [this.theme.fg("dim", "(pi built-in footer)")]),
      "",
      ...wrapTextWithAnsi(this.theme.fg("dim", this.helpText()), innerWidth),
      ...this.renderOptionShortcuts(innerWidth),
    );
    if (this.status.length > 0) {
      rows.push(this.theme.fg("warning", safeInline(this.status)));
    }
    const top = this.theme.fg(
      dirty ? "borderAccent" : "border",
      `╭${"─".repeat(Math.max(0, width - 2))}╮`,
    );
    const bottom = this.theme.fg(
      dirty ? "borderAccent" : "border",
      `╰${"─".repeat(Math.max(0, width - 2))}╯`,
    );
    return [
      top,
      ...rows.map(
        (value) =>
          `${this.theme.fg("border", "│")} ${padLine(value, innerWidth)} ${this.theme.fg("border", "│")}`,
      ),
      bottom,
    ].map((value) => line(value, width));
  }

  private actions(): string[] {
    return [
      `I Icons:${this.working.iconFamily}`,
      this.working.enabled ? "E Disable" : "E Enable",
      `W Preview:${PREVIEW_WIDTHS[this.previewWidth]}`,
      "R Reset",
      "S Save",
      "Q Close",
    ];
  }

  private changed(): void {
    this.invalidConfirmation = false;
    this.options.onPreview(cloneFooterConfig(this.working));
    this.requestRender();
  }

  private chips(): Chip[] {
    const chips = chipsFor(this.working, this.options.widgets);
    const grabbedIndex = this.grabbed
      ? chips.findIndex((chip) => chip.id === this.grabbed?.id)
      : -1;
    this.selected =
      grabbedIndex >= 0 ? grabbedIndex : Math.max(0, Math.min(this.selected, chips.length - 1));
    return chips;
  }

  private divider(label: string, width: number): string {
    const prefix = `◇ ${label} `;
    return this.theme.fg(
      "borderMuted",
      `${prefix}${"─".repeat(Math.max(0, width - visibleWidth(prefix)))}`,
    );
  }

  private helpText(): string {
    if (this.picker !== undefined) {
      return "Arrows / hjkl select · Enter add · Esc cancel";
    }
    if (this.grabbed) {
      return "Arrows / hjkl move · Enter drop · Esc cancel";
    }
    return "Arrows select · Enter pick/add · Del remove · i/e/w/r options · s save · Esc close";
  }

  private renderChip(chip: Chip, chips: Chip[]): string {
    const widget = this.options.widgets.find((candidate) => candidate.id === chip.id);
    const rawLabel = safeInline(widget?.label ?? chip.id);
    const label =
      chip.kind === "add"
        ? "+ Add"
        : chip.kind === "waiting"
          ? `${truncateToWidth(rawLabel, 14, "…")} · waiting`
          : truncateToWidth(rawLabel, 24, "…");
    const text = ` ${label} `;
    if (chips.indexOf(chip) === this.selected) {
      return this.theme.bg("selectedBg", this.theme.fg("accent", this.theme.bold(`›${text}‹`)));
    }
    return chip.kind === "waiting"
      ? this.theme.fg("warning", text)
      : chip.kind === "add"
        ? this.theme.fg("muted", text)
        : this.theme.fg("text", text);
  }

  private renderLayoutRow(rowIndex: number, chips: Chip[], width: number): string[] {
    const groups = GROUPS.map((group) => {
      const groupChips = chips.filter((chip) => chip.row === rowIndex && chip.group === group);
      const prefix = this.theme.fg(
        "dim",
        `${group === "left" ? "L" : group === "center" ? "C" : "R"} `,
      );
      return wrapSegments(
        prefix,
        groupChips.map((chip) => this.renderChip(chip, chips)),
        width >= 72 ? Math.floor((width - 4) / 3) : width,
      );
    });
    const label = this.theme.fg("muted", `ROW ${rowIndex + 1}`);
    return width >= 72 ? [label, ...joinColumns(groups, width)] : [label, ...groups.flat()];
  }

  private renderOptionShortcuts(width: number): string[] {
    return wrapSegments(
      "",
      this.actions().map((action) => this.theme.fg("dim", ` ${action} `)),
      width,
    );
  }

  private renderPicker(width: number): string[] {
    if (this.picker === undefined) {
      return [];
    }
    return [
      this.divider(`Add · row ${this.picker.row + 1} ${this.picker.group}`, width),
      ...this.picker.list.render(width),
    ];
  }

  private handleLayout(data: string, movement: ReturnType<typeof direction>, apply: boolean): void {
    const chips = this.chips();
    const selected = chips[this.selected];
    if (selected === undefined) {
      return;
    }
    if (this.grabbed !== undefined && movement !== undefined) {
      this.moveGrabbed(selected, movement);
      return;
    }
    if (movement === "left" || movement === "up") {
      this.selected = Math.max(0, this.selected - 1);
      return;
    }
    if (movement === "right" || movement === "down") {
      this.selected = Math.min(chips.length - 1, this.selected + 1);
      return;
    }
    if (matchesKey(data, Key.delete) || matchesKey(data, Key.backspace)) {
      if (selected.kind === "add") {
        return;
      }
      removeDirectPlacement(this.working, selected.id);
      ensureOverride(this.working, selected.id).enabled = false;
      this.changed();
      return;
    }
    if (!apply) {
      return;
    }
    if (this.grabbed !== undefined) {
      this.grabbed = undefined;
      this.changed();
      return;
    }
    if (selected.kind === "add") {
      const items = pickerItems(this.working, this.options.widgets, chips);
      if (items.length === 0) {
        this.status = "All widgets are already placed.";
        return;
      }
      this.status = "";
      this.openPicker(items, selected.row, selected.group);
      return;
    }
    const backup = cloneFooterConfig(this.working);
    if (selected.aggregate !== undefined) {
      place(this.working, selected.id, selected.row, selected.group, selected.index + 1);
    }
    this.grabbed = {
      backup,
      id: selected.id,
    };
    this.changed();
  }

  private handlePicker(data: string): void {
    if (this.picker === undefined) {
      return;
    }
    if (
      this.keybindings?.matches(data, "tui.select.up") === true ||
      this.keybindings?.matches(data, "tui.select.down") === true ||
      this.keybindings?.matches(data, "tui.select.confirm") === true ||
      this.keybindings?.matches(data, "tui.select.cancel") === true
    ) {
      this.picker.list.handleInput(data);
      return;
    }
    const movement = direction(data);
    if (movement !== undefined) {
      const selected = this.picker.list.getSelectedItem();
      const index = Math.max(0, this.picker.items.indexOf(selected!));
      const offset = movement === "left" || movement === "up" ? -1 : 1;
      this.picker.list.setSelectedIndex(
        (index + offset + this.picker.items.length) % this.picker.items.length,
      );
      return;
    }
    this.picker.list.handleInput(data);
  }

  private openPicker(items: readonly PickerItem[], row: number, group: Group): void {
    const choices: SelectItem[] = items.map((item) =>
      item.available
        ? { label: safeInline(item.label), value: item.id }
        : { description: "waiting", label: safeInline(item.label), value: item.id },
    );
    const list = new SelectList(choices, Math.min(choices.length, 6), {
      description: (text) => this.theme.fg("warning", text),
      noMatch: (text) => this.theme.fg("dim", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", this.theme.bold(text)),
    });
    list.onCancel = () => {
      this.picker = undefined;
    };
    list.onSelect = (item) => {
      place(this.working, item.value, row, group, this.working.rows[row]?.[group].length ?? 0);
      this.picker = undefined;
      this.status = "";
      this.changed();
    };
    this.picker = { group, items: choices, list, row };
  }

  private moveGrabbed(selected: Chip, movement: NonNullable<ReturnType<typeof direction>>): void {
    const { group, row } = selected;
    const index = this.working.rows[row]?.[group].indexOf(selected.id) ?? -1;
    if (movement === "up" || movement === "down") {
      const targetRow = Math.max(
        0,
        Math.min(this.working.rows.length - 1, row + (movement === "up" ? -1 : 1)),
      );
      if (targetRow === row) {
        return;
      }
      place(
        this.working,
        selected.id,
        targetRow,
        group,
        this.working.rows[targetRow]?.[group].length ?? 0,
      );
      this.changed();
      return;
    }
    const groupIndex = GROUPS.indexOf(group);
    const targetIndex = index + (movement === "left" ? -1 : 1);
    const values = this.working.rows[row]?.[group] ?? [];
    if (targetIndex >= 0 && targetIndex < values.length) {
      place(this.working, selected.id, row, group, targetIndex);
    } else {
      const nextGroup = Math.max(
        0,
        Math.min(GROUPS.length - 1, groupIndex + (movement === "left" ? -1 : 1)),
      );
      const next = GROUPS[nextGroup] ?? "left";
      if (next === group) {
        return;
      }
      place(
        this.working,
        selected.id,
        row,
        next,
        movement === "left" ? (this.working.rows[row]?.[next].length ?? 0) : 0,
      );
    }
    this.changed();
  }

  private handleShortcut(data: string): boolean {
    switch (data.toLowerCase()) {
      case "i": {
        const current = ICONS.indexOf(this.working.iconFamily);
        this.working.iconFamily = ICONS[(current + 1) % ICONS.length]!;
        this.changed();
        return true;
      }
      case "e": {
        this.working.enabled = !this.working.enabled;
        this.changed();
        return true;
      }
      case "w": {
        this.previewWidth = (this.previewWidth + 1) % PREVIEW_WIDTHS.length;
        return true;
      }
      case "r": {
        this.working = cloneFooterConfig(DEFAULT_CONFIG);
        this.changed();
        return true;
      }
      case "s": {
        this.save();
        return true;
      }
      case "q": {
        this.requestClose();
        return true;
      }
      default: {
        return false;
      }
    }
  }

  private requestClose(): void {
    if (!sameConfig(this.working, this.original)) {
      this.options.onPreview(cloneFooterConfig(this.original));
    }
    this.done(null);
  }

  private save(): void {
    if (this.sourceInvalid && !this.invalidConfirmation) {
      this.invalidConfirmation = true;
      this.status = "Invalid source file: choose Save again to replace it explicitly.";
      this.requestRender();
      return;
    }
    const snapshot = cloneFooterConfig(this.working);
    this.saveVersion += 1;
    const version = this.saveVersion;
    this.status = "Saving…";
    const previousSave = this.saveQueue;
    const save = async () => {
      try {
        await previousSave;
      } catch {
        // A failed save must not block later explicit saves.
      }
      await this.options.onSave(snapshot);
    };
    const savePromise = save();
    this.saveQueue = savePromise;
    const settle = async () => {
      try {
        await savePromise;
        this.original = cloneFooterConfig(snapshot);
        this.sourceInvalid = false;
        if (version === this.saveVersion) {
          this.status = sameConfig(this.working, snapshot)
            ? "Saved."
            : "Saved; newer changes are unsaved.";
        }
        this.requestRender();
      } catch (error) {
        if (version === this.saveVersion) {
          this.status = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        this.requestRender();
      }
    };
    void settle();
  }
}

export const showFooterEditor = async (
  ctx: FooterUiContext,
  options: FooterEditorOptions,
): Promise<void> => {
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) => {
      const editor = new FooterEditor(
        theme,
        () => {
          tui.requestRender();
        },
        done,
        options,
        keybindings,
      );
      return editor;
    },
    {
      overlay: true,
      overlayOptions: {
        margin: 1,
        maxHeight: "92%",
        minWidth: 40,
        width: 116,
      },
    },
  );
};

export const showFooterTextView = async (
  ctx: FooterUiContext,
  title: string,
  getLines: () => string[],
): Promise<void> => {
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) => {
      let offset = 0;
      return {
        dispose() {},
        handleInput(data: string) {
          if (
            keybindings.matches(data, "tui.select.cancel") ||
            keybindings.matches(data, "tui.select.confirm")
          ) {
            done(null);
            return;
          }
          if (keybindings.matches(data, "tui.select.up") || data === "k") {
            offset = Math.max(0, offset - 1);
          } else if (keybindings.matches(data, "tui.select.down") || data === "j") {
            offset += 1;
          }
          tui.requestRender();
        },
        invalidate() {},
        render(width: number) {
          const safeWidth = Math.max(1, width);
          const lines = [
            theme.fg("accent", theme.bold(title)),
            ...getLines(),
            "",
            theme.fg("dim", "↑/↓ scroll · Enter/Esc close"),
          ].flatMap((value) => wrapTextWithAnsi(value, safeWidth));
          offset = Math.min(offset, Math.max(0, lines.length - 1));
          return lines.slice(offset);
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        maxHeight: "80%",
        minWidth: 40,
        width: "80%",
      },
    },
  );
};
