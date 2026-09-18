import { copyToClipboard, getMarkdownTheme, highlightCode } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";
import type {
  Component,
  Focusable,
  Keybinding,
  KeybindingsManager,
  KeyId,
  MarkdownTheme,
  OverlayHandle,
  TUI,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import {
  countColumnWidth,
  fit,
  layoutOverlay,
  overlayHeight,
  PAD,
  renderFooter,
  renderOverlay,
  renderScrollbar,
  renderTreeRows,
} from "./render.js";
import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import type { Layout } from "./render.js";
import { parseMouseInput } from "./mouse.js";
import type { ContextSnapshot } from "./snapshot.js";
import { buildTree, filterTree, flattenTree, followSelection, groupIds } from "./tree.js";
import type { FlatRow, TreeNode } from "./tree.js";

/** Columns used by the preview's left padding and right scrollbar. */
const PREVIEW_GUTTER = PAD.length + 1;

export class ContextOverlay implements Component, Focusable {
  private readonly tree: readonly TreeNode[];
  private readonly expanded: Set<string>;
  private readonly search = new Input({ prompt: "/" });
  /** Pi's markdown theme resolves colors through the live global theme; only the indent differs. */
  private readonly markdownTheme: MarkdownTheme = { ...getMarkdownTheme(), codeBlockIndent: "" };
  private preview: Component = new Text("", 0, 0);
  private rows: readonly FlatRow[] = [];
  private countWidth = 0;
  private selected = 0;
  private scroll = 0;
  private previewScroll = 0;
  private detail = false;
  private editing = false;
  private hasFocus = false;
  private pageSize = 1;
  private previewFocused = false;
  private maxPreviewScroll = 0;
  private layout: Layout | undefined;
  private mouseHandle: OverlayHandle | undefined;
  private mouseReporting = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly snapshot: ContextSnapshot,
    private readonly ui: Pick<ExtensionUIContext, "notify">,
    private readonly done: () => void,
  ) {
    this.tree = buildTree(snapshot);
    this.expanded = new Set(groupIds(this.tree));
    this.rebuildRows();
  }

  get focused(): boolean {
    return this.hasFocus;
  }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.search.focused = value && this.editing;
    this.setMouseReporting(value && this.mouseHandle !== undefined);
  }

  attachMouse(handle: OverlayHandle): void {
    // Fullscreen Pi already routes normalized mouse events. Regular mode needs scoped reporting.
    if (this.tui.mode !== "regular") return;
    this.mouseHandle = handle;
    this.setMouseReporting(this.hasFocus);
  }

  private setMouseReporting(enabled: boolean): void {
    if (enabled === this.mouseReporting) return;
    this.mouseReporting = enabled;
    // Plain enable/disable, as Pi's own fullscreen mode does; XTSAVE/XTRESTORE is not universal.
    this.tui.terminal.write(enabled ? "\u001B[?1000h\u001B[?1006h" : "\u001B[?1006l\u001B[?1000l");
  }

  dispose(): void {
    this.setMouseReporting(false);
    this.mouseHandle = undefined;
  }

  private scrollPreview(delta: number): void {
    this.previewScroll = Math.max(0, Math.min(this.maxPreviewScroll, this.previewScroll + delta));
  }

  /** Scrolls the preview when it owns navigation, otherwise moves the tree selection. */
  private move(delta: number): void {
    if (this.detail || this.previewFocused) this.scrollPreview(delta);
    else this.select(this.selected + delta);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel" && !(event.type === "press" && event.button === "left")) return;
    const layout = this.layout;

    if (!layout || this.editing) return { handled: true };
    const row = event.y - layout.bodyTop;

    if (event.x < 1 || event.x >= layout.width - 1 || row < 0 || row >= layout.bodyHeight)
      return { handled: true };
    const inPreview = this.detail || (layout.previewWidth > 0 && event.x > layout.treeWidth + 1);

    if (event.type === "wheel") {
      const delta = event.wheelDelta ?? 0;

      if (inPreview) this.scrollPreview(delta);
      else this.select(this.selected + delta);
    } else {
      if (!this.detail) this.previewFocused = inPreview;

      if (!inPreview && this.scroll + row < this.rows.length) this.select(this.scroll + row);
    }

    this.tui.requestRender();

    return { handled: true, focus: true };
  }

  private rebuildRows(expandMatches = false, targetId = this.rows[this.selected]?.node.id): void {
    const filtered = filterTree(this.tree, this.search.getValue());

    if (expandMatches && this.search.getValue().trim()) {
      for (const node of filtered) this.expanded.add(node.id);
    }

    this.rows = flattenTree(filtered, this.expanded);
    this.countWidth = countColumnWidth(this.rows);
    this.select(
      Math.max(
        0,
        this.rows.findIndex((row) => row.node.id === targetId),
      ),
    );
  }

  private select(index: number): void {
    this.selected = Math.max(0, Math.min(index, this.rows.length - 1));
    this.previewScroll = 0;
    this.preview = this.createPreview(this.rows[this.selected]?.node);
  }

  private createPreview(node: TreeNode | undefined): Component {
    const body = displayText(node?.body || "(empty)");

    switch (node?.format) {
      case "markdown":
        return new Markdown(body, 0, 0, this.markdownTheme);
      case "json":
        return new Text(highlightCode(body, "json").join("\n"), 0, 0);
      default:
        return new Text(body, 0, 0);
    }
  }

  private fold(expand: boolean): void {
    const row = this.rows[this.selected];

    if (!row) return;
    // Resolve the target first so the rebuild selects (and builds a preview) exactly once.
    let target = row.node.id;

    if (expand && row.node.children.length > 0) {
      if (row.expanded) target = this.rows[this.selected + 1]?.node.id ?? target;
      else this.expanded.add(row.node.id);
    } else if (!expand && row.depth > 0) {
      // flattenTree emits every parent before its descendants; a non-root row has an ancestor.
      const parent = this.rows
        .slice(0, this.selected)
        .findLast((candidate) => candidate.depth < row.depth)!;

      target = parent.node.id;
    } else if (!expand) {
      this.expanded.delete(row.node.id);
    }

    this.rebuildRows(false, target);
  }

  private async copy(): Promise<void> {
    const node = this.rows[this.selected]?.node;

    if (!node) return;

    try {
      await copyToClipboard(node.body);
      this.ui.notify(`Copied ${displayText(node.label)}`, "info");
    } catch {
      this.ui.notify("Clipboard copy failed", "error");
    }
  }

  /** Escape unwinds one layer at a time: details, preview focus, search filter, then the overlay. */
  private back(): void {
    if (this.detail) this.detail = false;
    else if (this.previewFocused) this.previewFocused = false;
    else if (this.search.getValue()) {
      this.search.setValue("");
      this.rebuildRows();
    } else this.done();
  }

  private handleSearchInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.search.setValue("");
      this.editing = false;
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.editing = false;
    } else {
      this.search.handleInput(data);
    }

    this.search.focused = this.hasFocus && this.editing;
    this.rebuildRows(true);
  }

  handleInput(data: string): void {
    if (this.mouseHandle && data.startsWith("\u001B[<")) {
      const event = parseMouseInput(data, this.mouseHandle.getBounds());

      if (event) this.handleMouse(event);

      return;
    }

    if (this.editing) {
      this.handleSearchInput(data);
      this.tui.requestRender();

      return;
    }

    const key = (id: KeyId) => matchesKey(data, id);
    const action = (id: Keybinding) => this.keybindings.matches(data, id);
    const treeMode = !this.detail && !this.previewFocused;

    // First matching binding wins. Configured Pi actions come before the fixed keys and vim-style
    // aliases so a user's remapping is never shadowed by a built-in.
    const bindings: Array<[boolean, () => void]> = [
      [action("tui.select.cancel"), () => this.back()],
      [
        action("tui.select.confirm"),
        () => {
          this.detail = this.rows.length > 0;
        },
      ],
      [action("tui.select.pageDown"), () => this.move(this.pageSize)],
      [action("tui.select.pageUp"), () => this.move(-this.pageSize)],
      [action("tui.select.down"), () => this.move(1)],
      [action("tui.select.up"), () => this.move(-1)],
      [
        key(Key.tab) && (this.layout?.previewWidth ?? 0) > 0,
        () => {
          this.previewFocused = !this.previewFocused;
        },
      ],
      [key("y"), () => void this.copy()],
      [
        key(Key.slash) && !this.detail,
        () => {
          this.editing = true;
          this.previewFocused = false;
          this.search.focused = this.hasFocus;
        },
      ],
      [treeMode && (key(Key.right) || key("l")), () => this.fold(true)],
      [treeMode && (key(Key.left) || key("h")), () => this.fold(false)],
      [treeMode && key(Key.space), () => this.fold(!this.rows[this.selected]?.expanded)],
      [key("j"), () => this.move(1)],
      [key("k"), () => this.move(-1)],
    ];

    bindings.find(([matched]) => matched)?.[1]();
    this.tui.requestRender();
  }

  invalidate(): void {
    // Rebuild rather than invalidate: JSON previews hold pre-highlighted text from the old theme.
    this.preview = this.createPreview(this.rows[this.selected]?.node);
    this.search.invalidate();
  }

  private renderPreview(row: FlatRow, paneWidth: number, layout: Layout) {
    const contentWidth = Math.max(1, paneWidth - PREVIEW_GUTTER);
    const viewport = Math.max(1, layout.bodyHeight - layout.previewHeaderRows);
    const lines = this.preview.render(contentWidth);
    this.maxPreviewScroll = Math.max(0, lines.length - viewport);
    this.previewScroll = Math.min(this.previewScroll, this.maxPreviewScroll);
    const offset = this.previewScroll;
    const end = Math.min(offset + viewport, lines.length);
    const scrollbar = renderScrollbar(this.theme, viewport, offset, lines.length);
    const position = `${offset + 1}-${end} / ${lines.length}`;

    const header = [
      this.theme.bold(displayText(row.node.label)),
      this.theme.fg("muted", `  ~${row.node.estimatedTokens.toLocaleString("en-US")}`),
      this.theme.fg("dim", " · "),
      this.theme.fg("muted", position),
    ].join("");

    return {
      position,
      lines: [
        fit(`${PAD}${header}`, paneWidth),
        ...(layout.previewHeaderRows > 1
          ? [fit(`${PAD}${this.theme.fg("borderMuted", "─".repeat(contentWidth))}`, paneWidth)]
          : []),
        ...Array.from(
          { length: viewport },
          (_, index) =>
            `${fit(`${PAD}${lines[offset + index] ?? ""}`, paneWidth - 1)}${scrollbar[index]}`,
        ),
      ],
    };
  }

  render(width: number): string[] {
    const layout = layoutOverlay(width, overlayHeight(this.tui.terminal.rows), this.detail);
    this.layout = layout;
    const { innerWidth, treeWidth, previewWidth, bodyHeight } = layout;

    if (layout.tooSmall) return renderOverlay(this.theme, this.snapshot, layout, [], "");

    // The preview pane disappears below the split width; do not leave keyboard focus on it.
    if (previewWidth === 0) this.previewFocused = false;
    this.pageSize = Math.max(
      1,
      bodyHeight - (this.detail || this.previewFocused ? layout.previewHeaderRows : 0),
    );
    this.scroll = followSelection(this.selected, this.scroll, bodyHeight, this.rows.length);

    const body =
      this.rows.length === 0
        ? [`${PAD}${this.theme.fg("muted", "No matches")}`]
        : renderTreeRows(
            this.theme,
            this.rows.slice(this.scroll, this.scroll + bodyHeight),
            this.selected - this.scroll,
            treeWidth,
            this.countWidth,
          );

    let position = "";
    const selectedRow = this.rows[this.selected];
    const showPreview = (this.detail || previewWidth > 0) && selectedRow !== undefined;

    if (showPreview) {
      const preview = this.renderPreview(
        selectedRow,
        this.detail ? innerWidth : previewWidth,
        layout,
      );

      if (this.detail) {
        body.splice(0, body.length, ...preview.lines);
        position = preview.position;
      } else {
        const divider = this.theme.fg(this.previewFocused ? "borderAccent" : "borderMuted", "│");

        for (let index = 0; index < bodyHeight; index += 1) {
          body[index] =
            `${fit(body[index] ?? "", treeWidth)}${divider}${preview.lines[index] ?? ""}`;
        }
      }
    }

    const confirm = this.keybindings.getKeys("tui.select.confirm").join("/");
    const cancel = this.keybindings.getKeys("tui.select.cancel").join("/");

    const keys = [
      { key: "j/k", label: "scroll", show: this.detail },
      {
        key: "tab",
        label: this.previewFocused ? "tree" : "preview",
        show: !this.detail && previewWidth > 0,
      },
      { key: confirm, label: "details", show: !this.detail },
      { key: "y", label: "copy", show: true },
      { key: "/", label: "search", show: !this.detail },
      { key: cancel, label: "back", show: true },
    ].filter((item) => item.show);

    const query = this.search.getValue();
    const right = this.detail ? position : query ? `/${query}` : "";

    const footer = this.editing
      ? this.search.render(innerWidth - PAD.length).join("")
      : renderFooter(this.theme, keys, right, innerWidth - 2 * PAD.length);

    return renderOverlay(
      this.theme,
      this.snapshot,
      layout,
      body,
      footer,
      showPreview && !this.detail && this.previewFocused,
    );
  }
}
