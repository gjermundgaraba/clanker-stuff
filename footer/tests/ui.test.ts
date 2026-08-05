import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { createIdentityTheme } from "../../tests/harness/tui.js";
import { cloneFooterConfig, DEFAULT_CONFIG } from "../config.js";
import type { FooterConfig } from "../types.js";
import { FooterEditor, showFooterEditor } from "../ui.js";

describe("footer editor", () => {
  it("moves a grabbed chip through the real row configuration", () => {
    let preview: FooterConfig | undefined;
    const editor = new FooterEditor(
      createIdentityTheme(),
      vi.fn<() => void>(),
      vi.fn<(value: null) => void>(),
      {
        loaded: {
          config: cloneFooterConfig(DEFAULT_CONFIG),
        },
        onPreview: (config) => {
          preview = config;
        },
        onSave: async () => {
          await Promise.resolve();
        },
        renderPreview: () => [],
        widgets: [
          { id: "footer.cwd", label: "cwd", source: "builtin" },
          { id: "footer.git", label: "git", source: "builtin" },
          { id: "footer.model", label: "model", source: "builtin" },
          { id: "footer.thinking", label: "thinking", source: "builtin" },
          { id: "footer.context", label: "context", source: "builtin" },
        ],
      }
    );

    editor.handleInput("\r");
    editor.handleInput("\u001B[C");
    editor.handleInput("\r");

    expect(preview?.rows[0]?.left).toStrictEqual(["footer.git", "footer.cwd"]);
    expect(
      editor.render(40).every((line) => visibleWidth(line) <= 40)
    ).toBeTruthy();
  });

  it("keeps every option visible at 40 columns without tabs", () => {
    const editor = new FooterEditor(
      createIdentityTheme(),
      vi.fn<() => void>(),
      vi.fn<(value: null) => void>(),
      {
        loaded: {
          config: cloneFooterConfig(DEFAULT_CONFIG),
        },
        onPreview: vi.fn<(config: FooterConfig) => void>(),
        onSave: async () => {
          await Promise.resolve();
        },
        renderPreview: () => [],
        widgets: [{ id: "footer.cwd", label: "cwd", source: "builtin" }],
      }
    );

    const rendered = editor.render(40);
    const text = rendered.join("\n");

    expect(text).toContain("Q Close");
    expect(text).toContain("+ Add");
    expect(text).not.toMatch(
      /D Discard|File|Widget settings|◇ (?:Omitted|Options|Selected|Waiting)/u
    );
    expect(
      text.indexOf("ROW 3") < text.indexOf("Live preview") &&
        text.indexOf("Live preview") < text.indexOf("Arrows select")
    ).toBeTruthy();
    expect(rendered.every((value) => visibleWidth(value) <= 40)).toBeTruthy();
  });

  it("supports direct reset and save shortcuts", async () => {
    const onSave = vi.fn<(config: FooterConfig) => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const editor = new FooterEditor(
      createIdentityTheme(),
      vi.fn<() => void>(),
      vi.fn<(value: null) => void>(),
      {
        loaded: {
          config: {
            ...cloneFooterConfig(DEFAULT_CONFIG),
            iconFamily: "ascii",
            rows: [{ center: [], left: ["footer.cwd"], right: [] }],
          },
        },
        onPreview: vi.fn<(config: FooterConfig) => void>(),
        onSave,
        renderPreview: () => [],
        widgets: [{ id: "footer.cwd", label: "Working directory" }],
      }
    );

    editor.handleInput("r");
    editor.handleInput("s");

    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledOnce();
      expect(onSave.mock.calls[0]?.[0]).toStrictEqual(DEFAULT_CONFIG);
    });
  });

  it("restores the loaded preview when closed without saving", () => {
    const done = vi.fn<(value: null) => void>();
    const onPreview = vi.fn<(config: FooterConfig) => void>();
    const editor = new FooterEditor(
      createIdentityTheme(),
      vi.fn<() => void>(),
      done,
      {
        loaded: {
          config: cloneFooterConfig(DEFAULT_CONFIG),
        },
        onPreview,
        onSave: async () => {
          await Promise.resolve();
        },
        renderPreview: () => [],
        widgets: [],
      }
    );

    editor.handleInput("i");
    editor.handleInput("q");

    expect(onPreview.mock.calls.at(-1)?.[0]).toStrictEqual(DEFAULT_CONFIG);
    expect(done).toHaveBeenCalledWith(null);
  });

  it("opens as a bounded overlay", async () => {
    let customOptions: unknown;
    const custom: ExtensionCommandContext["ui"]["custom"] = async (
      _factory,
      options
    ) => {
      customOptions = options;
      await Promise.resolve();
      return null as never;
    };

    await showFooterEditor(
      {
        ui: { custom },
      } as never,
      {
        loaded: {
          config: cloneFooterConfig(DEFAULT_CONFIG),
        },
        onPreview: vi.fn<(config: FooterConfig) => void>(),
        onSave: async () => {
          await Promise.resolve();
        },
        renderPreview: () => [],
        widgets: [],
      }
    );

    expect(customOptions).toStrictEqual({
      overlay: true,
      overlayOptions: {
        margin: 1,
        maxHeight: "92%",
        minWidth: 40,
        width: 116,
      },
    });
  });

  it("adds an unplaced aggregate member through its cell picker", () => {
    let preview: FooterConfig | undefined;
    const config: FooterConfig = {
      enabled: true,
      iconFamily: "unicode",
      rows: [{ center: [], left: ["footer.widgets"], right: [] }],
      separator: "·",
      version: 1,
      widgets: { "example.rich": { enabled: false } },
    };
    const editor = new FooterEditor(
      createIdentityTheme(),
      vi.fn<() => void>(),
      vi.fn<(value: null) => void>(),
      {
        loaded: { config },
        onPreview: (value) => {
          preview = value;
        },
        onSave: async () => {
          await Promise.resolve();
        },
        renderPreview: () => [],
        widgets: [{ id: "example.rich", label: "rich", source: "rich" }],
      }
    );

    editor.handleInput("\r");
    expect(editor.render(80).join("\n")).toContain("◇ Add · row 1 left");
    editor.handleInput("\r");

    expect(preview?.rows[0]?.left).toStrictEqual([
      "footer.widgets",
      "example.rich",
    ]);

    editor.handleInput("\u001B[3~");
    expect(preview?.rows[0]?.left).toStrictEqual(["footer.widgets"]);
    expect(editor.render(80).join("\n")).not.toContain("Omitted");
  });

  it("requires invalid-file replacement confirmation only once", async () => {
    const onSave = vi.fn<(config: FooterConfig) => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const editor = new FooterEditor(
      createIdentityTheme(),
      vi.fn<() => void>(),
      vi.fn<(value: null) => void>(),
      {
        loaded: {
          config: cloneFooterConfig(DEFAULT_CONFIG),
          error: "footer.json is invalid",
        },
        onPreview: vi.fn<(config: FooterConfig) => void>(),
        onSave,
        renderPreview: () => [],
        widgets: [{ id: "footer.cwd", label: "cwd", source: "builtin" }],
      }
    );

    editor.handleInput("s");
    expect(onSave).not.toHaveBeenCalled();
    editor.handleInput("s");
    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledOnce();
      expect(editor.render(80).join("\n")).toContain("Saved.");
    });

    editor.handleInput("i");
    editor.handleInput("s");
    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps large add pickers bounded and scrollable", () => {
    const editor = new FooterEditor(
      createIdentityTheme(),
      vi.fn<() => void>(),
      vi.fn<(value: null) => void>(),
      {
        loaded: {
          config: {
            enabled: true,
            iconFamily: "unicode",
            rows: [{ center: [], left: [], right: [] }],
            separator: "·",
            version: 1,
            widgets: {},
          },
        },
        onPreview: vi.fn<(config: FooterConfig) => void>(),
        onSave: async () => {
          await Promise.resolve();
        },
        renderPreview: () => [],
        widgets: Array.from({ length: 100 }, (_value, index) => ({
          id: `example.widget-${index.toString().padStart(3, "0")}`,
          label: `Widget ${index.toString().padStart(3, "0")}`,
          source: "rich" as const,
        })),
      }
    );

    editor.handleInput("\r");
    for (let index = 0; index < 6; index += 1) {
      editor.handleInput("\u001B[B");
    }
    const rendered = editor.render(80).join("\n");

    expect(rendered).toContain("Widget 006");
    expect(rendered).toContain("(7/100)");
    expect(rendered).not.toContain("Widget 099");
  });
});
