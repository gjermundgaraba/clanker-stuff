import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_CONFIG, parseFooterConfig } from "../config.js";

describe(parseFooterConfig, () => {
  it("rejects unknown config fields", () => {
    expect(() =>
      parseFooterConfig({
        enabled: true,
        iconFamily: "unicode",
        rows: [{ center: [], left: [], right: [] }],
        separator: "·",
        unknown: true,
        version: 1,
        widgets: {},
      }),
    ).toThrow("strict object");
  });

  it("rejects control-bearing widget IDs in configuration", () => {
    const nativeId = "status:line\n\u001B[31m";
    expect(() =>
      parseFooterConfig({
        enabled: true,
        iconFamily: "unicode",
        rows: [{ center: [], left: [nativeId], right: [] }],
        separator: "·",
        version: 1,
        widgets: {},
      }),
    ).toThrow("terminal controls");
    expect(() =>
      parseFooterConfig({
        enabled: true,
        iconFamily: "unicode",
        rows: [{ center: [], left: [], right: [] }],
        separator: "·",
        version: 1,
        widgets: { [nativeId]: { enabled: false } },
      }),
    ).toThrow("terminal controls");
  });
});

describe("footer config constraints and copying", () => {
  it("uses code-point limits and copies rows and overrides", () => {
    const row = { left: ["🦄".repeat(256)], center: [], right: [] };
    const widget = { enabled: false };

    const source = {
      ...DEFAULT_CONFIG,
      separator: "🦄".repeat(8),
      rows: [row],
      widgets: { ["🦄".repeat(256)]: widget },
    };

    const config = parseFooterConfig(source);
    row.left[0] = "changed";
    widget.enabled = true;
    expect(config.rows[0]?.left[0]).toBe("🦄".repeat(256));
    expect(config.widgets["🦄".repeat(256)]).toStrictEqual({ enabled: false });
    expect(config.separator).toBe("🦄".repeat(8));
  });

  it("retains semantic separator diagnostics", () => {
    expect(() => parseFooterConfig({ ...DEFAULT_CONFIG, separator: "\u0085" })).toThrow(
      "printable code points",
    );
  });
});
