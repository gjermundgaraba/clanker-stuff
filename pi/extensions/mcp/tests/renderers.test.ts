import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createIdentityTheme } from "../../../tests/harness/tui.js";
import { renderedRows, toolRenderContext } from "../../../tests/harness/tool-rendering.js";
import { mcpRenderers } from "../renderers.js";

const theme = createIdentityTheme();

const result = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

beforeAll(() => initTheme("dark"));

describe("MCP presentation", () => {
  it("uses server and tool names, readable arguments and expandable object detail", () => {
    const renderer = mcpRenderers("github", "search_issues").renderCall;
    const args = { query: "bug", filter: { owner: "clanker" } };
    const collapsed = renderedRows(renderer(args, theme, toolRenderContext())).join("\n");
    expect(collapsed).toBe("github: search_issues\nquery: bug\nfilter: {…}");

    const expanded = renderedRows(
      renderer(args, theme, toolRenderContext({ expanded: true })),
    ).join("\n");

    expect(expanded).toContain('"owner": "clanker"');
  });
  it("never reveals manager config credentials, including in expanded calls", () => {
    const args = {
      name: "private",
      scope: "project",
      config: {
        type: "http",
        url: "https://user:password@example.com",
        headers: { Authorization: "Bearer SECRET" },
        env: { TOKEN: "secret-env" },
        args: ["--password=abc"],
      },
    };

    for (const expanded of [false, true]) {
      const text = renderedRows(
        mcpRenderers("mcp-manager", "mcp_set", true).renderCall(
          args,
          theme,
          toolRenderContext({ expanded }),
        ),
      ).join("\n");

      expect(text).toBe(
        "mcp_set private\nproject · http" + (expanded ? "\nAdditional configuration hidden" : ""),
      );
      expect(text).not.toMatch(/password|SECRET|secret-env|abc/u);
    }
  });
  it("shows only allowlisted operational settings in expanded manager calls", () => {
    for (const type of ["http", "stdio"]) {
      const args = {
        name: "private",
        scope: "project",
        config: {
          type,
          heartbeatIntervalMs: 0,
          heartbeatTimeoutMs: 500,
          url: "https://user:SECRET@example.com",
          command: "SECRET-executable",
          env: { TOKEN: "SECRET-env" },
          args: ["SECRET-arg"],
          headers: { Authorization: "SECRET-header" },
          oauth: { callbackPort: 8765, clientSecret: "SECRET-oauth" },
          futureSetting: 123,
        },
      };

      const renderer = mcpRenderers("mcp-manager", "mcp_set", true).renderCall;
      const collapsed = renderedRows(renderer(args, theme, toolRenderContext())).join("\n");
      expect(collapsed).toBe(`mcp_set private\nproject · ${type}`);

      const expanded = renderedRows(
        renderer(args, theme, toolRenderContext({ expanded: true })),
      ).join("\n");

      expect(expanded).toContain("heartbeatIntervalMs: 0\nheartbeatTimeoutMs: 500");
      expect(expanded).toContain("oauth.callbackPort: 8765");
      expect(expanded).toContain("Additional configuration hidden");
      expect(expanded).not.toMatch(/SECRET|futureSetting|123/u);
    }
  });
  it("keeps nonnumeric heartbeat fields hidden without hiding attempted numeric values", () => {
    const renderer = mcpRenderers("mcp-manager", "mcp_set", true).renderCall;

    for (const value of [undefined, null, "SECRET", { token: "SECRET" }, ["SECRET"], true]) {
      const args = { config: { heartbeatIntervalMs: value, heartbeatTimeoutMs: value } };
      expect(
        renderedRows(renderer(args, theme, toolRenderContext({ expanded: true }))).join("\n"),
      ).toBe("mcp_set\nAdditional configuration hidden");
    }

    for (const value of [0, -1, 0.5, 2_147_483_648, Infinity, NaN]) {
      const args = { config: { heartbeatIntervalMs: value, heartbeatTimeoutMs: value } };
      expect(
        renderedRows(renderer(args, theme, toolRenderContext({ expanded: true }))).join("\n"),
      ).toBe(`mcp_set\nheartbeatIntervalMs: ${value}\nheartbeatTimeoutMs: ${value}`);
    }
  });
  it("preserves source meaning in both previews and expanded output", () => {
    const renderer = mcpRenderers("server", "tool").renderResult;

    for (const text of [
      "- removed\n+ added",
      "**literal**",
      '"**literal**"',
      '{"n":9007199254740993,"n":2}',
      'const value = "**literal**";\n  return a_b_c < limit;',
      "# Heading\n\n**Found**\n1. First\n2. Second",
    ]) {
      const data = result(text);
      const original = structuredClone(data);

      for (const expanded of [false, true]) {
        expect(
          renderedRows(
            renderer(data, { expanded, isPartial: false }, theme, toolRenderContext({ expanded })),
          ).join("\n"),
        ).toBe(text);
      }

      expect(data).toEqual(original);
    }
  });
  it("does not claim configuration was hidden when every field is displayed", () => {
    const renderer = mcpRenderers("mcp-manager", "mcp_set", true).renderCall;

    for (const callbackPort of [0, -1, 0.5, 8765]) {
      const text = renderedRows(
        renderer(
          { config: { type: "http", oauth: { callbackPort } } },
          theme,
          toolRenderContext({ expanded: true }),
        ),
      ).join("\n");

      expect(text).toBe(`mcp_set\nhttp\noauth.callbackPort: ${callbackPort}`);
    }

    for (const oauth of [{ callbackPort: "SECRET" }, { "SECRET-key": "SECRET" }, "SECRET", null]) {
      const text = renderedRows(
        renderer({ config: { oauth } }, theme, toolRenderContext({ expanded: true })),
      ).join("\n");

      expect(text).toBe("mcp_set\nAdditional configuration hidden");
    }
  });
  it("preserves text-block boundaries while still sanitizing terminal controls", () => {
    const data = {
      content: [
        { type: "text" as const, text: "- removed\n+ added\u001b[2J" },
        { type: "text" as const, text: "" },
        { type: "text" as const, text: '{"n":9007199254740993}' },
        { type: "text" as const, text: "\t**literal**" },
      ],
      details: undefined,
    };

    for (const expanded of [false, true]) {
      const component = mcpRenderers("server", "tool").renderResult(
        data,
        { expanded, isPartial: false },
        theme,
        toolRenderContext({ expanded: true }),
      );

      expect(renderedRows(component).join("\n")).toBe(
        '- removed\n+ added\n\n{"n":9007199254740993}\n   **literal**',
      );

      for (const width of [1, 2, 20, 80]) {
        const rows = component.render(width);
        expect(rows.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(rows.join("\n")).not.toContain("\u001b[2J");
      }
    }
  });
  it("keeps output warnings visible ahead of long output and expands it on demand", () => {
    const renderer = mcpRenderers("server", "tool").renderResult;

    const data = {
      content: [
        ...result(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")).content,
        {
          type: "text" as const,
          text: "[MCP output truncated: 1KB total text]\n[Persisted output: /tmp/result.txt; temporary, may be partial]",
        },
      ],
      details: { truncated: true, outputPath: "/tmp/result.txt", overflowNoticeIndex: 1 },
    };

    const original = structuredClone(data);

    const collapsed = renderedRows(
      renderer(data, { expanded: false, isPartial: false }, theme, toolRenderContext()),
    ).join("\n");

    expect(collapsed).toContain("MCP output truncated");
    expect(collapsed).toContain("Persisted output: /tmp/result.txt");
    expect(collapsed).not.toContain("line 29");
    expect(collapsed).toContain("to expand");
    expect(
      renderedRows(
        renderer(
          data,
          { expanded: true, isPartial: false },
          theme,
          toolRenderContext({ expanded: true }),
        ),
      ).join("\n"),
    ).toContain("line 29");
    expect(data).toEqual(original);
  });
  it.each(["0", 0.5, null, -1, 100])(
    "does not hide content for an invalid overflow index (%s)",
    (overflowNoticeIndex) => {
      const data = { ...result("original content"), details: { overflowNoticeIndex } };

      const output = mcpRenderers("server", "tool").renderResult(
        data,
        { expanded: true, isPartial: false },
        theme,
        toolRenderContext(),
      );

      expect(renderedRows(output).join("\n")).toBe("original content");
    },
  );

  it("leaves images to Pi and provides a hidden-image indicator", () => {
    const data = {
      content: [{ type: "image" as const, data: "BASE64", mimeType: "image/png" }],
      details: undefined,
    };

    expect(
      renderedRows(
        mcpRenderers("server", "image").renderResult(
          data,
          { expanded: false, isPartial: false },
          theme,
          toolRenderContext(),
        ),
      ).join("\n"),
    ).toBe("1 image (previews hidden)");
  });
  it("preserves historical notices and does not recognize remote text by its wording", () => {
    const text = "[MCP output truncated: remote text]\n[Persisted output: remote text]";

    for (const overflowNoticeIndex of [undefined, -1, 0.5, 10, "0", null]) {
      const data = {
        ...result(text),
        details: { truncated: true, outputPath: "/old/path", overflowNoticeIndex },
      };

      for (const expanded of [false, true]) {
        expect(
          renderedRows(
            mcpRenderers("server", "tool").renderResult(
              data,
              { expanded, isPartial: false },
              theme,
              toolRenderContext({ expanded }),
            ),
          ).join("\n"),
        ).toBe(text);
      }
    }
  });
  it("bounds narrow layouts and removes hostile terminal controls", () => {
    const renderers = mcpRenderers("server\u001b[2J", "tool");

    const component = renderers.renderCall(
      { query: "x".repeat(1000) + "END" },
      theme,
      toolRenderContext(),
    );

    for (const width of [1, 2, 20, 80]) {
      const rows = component.render(width);
      expect(rows.length).toBeLessThanOrEqual(4);
      expect(rows.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(rows.join("\n")).not.toContain("\u001b[2J");
    }

    for (const isError of [false, true]) {
      const text = renderedRows(
        renderers.renderResult(
          result("Danger\u001b[2J"),
          { expanded: false, isPartial: false },
          theme,
          toolRenderContext({ isError }),
        ),
      ).join("\n");

      expect(text).toContain("Danger");
      expect(text).not.toContain("[2J");
    }

    expect(() =>
      renderedRows(renderers.renderCall(null, theme, toolRenderContext({ isPartial: true }))),
    ).not.toThrow();
  });
  it("does not claim a partial request succeeded", () => {
    const renderer = mcpRenderers("mcp-manager", "mcp_connect", true).renderResult;

    const pending = renderedRows(
      renderer(
        result(""),
        { expanded: false, isPartial: true },
        theme,
        toolRenderContext({ isPartial: true }),
      ),
    ).join("\n");

    expect(pending).toBe("● working");
  });
  it("refreshes cached styling after theme invalidation", () => {
    const renderer = mcpRenderers("mcp-manager", "mcp_connect", true).renderResult;
    const changingTheme = createIdentityTheme();
    let color = "\u001b[31m";
    changingTheme.fg = (_name, text) => `${color}${text}\u001b[0m`;

    const component = renderer(
      result("Connected"),
      { expanded: false, isPartial: false },
      changingTheme,
      toolRenderContext(),
    );

    expect(component.render(80).join("\n")).toContain("\u001b[31mConnected");
    color = "\u001b[32m";
    expect(component.render(80).join("\n")).toContain("\u001b[31mConnected");
    component.invalidate();
    const refreshed = component.render(80).join("\n");
    expect(refreshed).toContain("\u001b[32mConnected");
    expect(refreshed).not.toContain("\u001b[31m");
  });
});
