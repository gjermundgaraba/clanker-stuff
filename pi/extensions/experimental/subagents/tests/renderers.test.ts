import type { JsonValue } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import {
  jsonToolResult,
  renderedRows,
  toolRenderContext,
} from "../../../../tests/harness/tool-rendering.js";
import { createIdentityTheme } from "../../../../tests/harness/tui.js";
import { errorCompletion } from "../prompts.js";
import { envelopeText, SUBAGENT_MESSAGE_TYPE } from "../protocol.js";
import type { Envelope } from "../protocol.js";
import { agentRenderers, mailRenderer } from "../renderers.js";

const theme = createIdentityTheme();

const render = (name: string, value: JsonValue, expanded = false) =>
  agentRenderers(name).renderResult(
    jsonToolResult(value),
    { expanded, isPartial: false },
    theme,
    toolRenderContext({ expanded })
  );

const card = (
  { failed, ...mail }: Envelope & { failed?: true },
  expanded = false
) => {
  const component = mailRenderer(
    {
      content: envelopeText(mail),
      customType: SUBAGENT_MESSAGE_TYPE,
      details: { ...(failed === undefined ? {} : { failed }), id: "mail" },
      display: true,
      role: "custom",
      timestamp: 0,
    },
    { expanded, outputPad: 0 },
    theme
  );

  return component === undefined
    ? []
    : renderedRows(component).map((row) => row.trimEnd());
};

describe("subagent renderers", () => {
  beforeAll(() => {
    initTheme("dark");
  });

  describe("agent presentation", () => {
    it("refreshes the interrupt summary along with the status on invalidation", () => {
      const changing = createIdentityTheme();
      let color = "\u001B[31m";
      changing.fg = (_name, value) => `${color + value}\u001B[0m`;

      const component = agentRenderers("interrupt_agent").renderResult(
        jsonToolResult({ previous_status: "running" }),
        { expanded: false, isPartial: false },
        changing,
        toolRenderContext()
      );

      expect(component.render(80).join("\n")).toContain(
        "\u001B[31m■ Interrupted"
      );
      color = "\u001B[32m";
      component.invalidate();
      const refreshed = component.render(80).join("\n");
      expect(refreshed).toContain("\u001B[32m■ Interrupted");
      expect(refreshed).not.toContain("\u001B[31m");
    });

    it.each([false, true])(
      "shows the spawned path and resolved settings (expanded=%s)",
      (expanded) => {
        const result = {
          ...jsonToolResult({ task_name: "/root/review" }),
          details: { model: "provider/child", thinkingLevel: "off" },
        };

        const original = structuredClone(result);

        const component = agentRenderers("spawn_agent").renderResult(
          result,
          { expanded, isPartial: false },
          theme,
          {
            ...toolRenderContext({ expanded }),
            args: { model: "requested", reasoning_effort: "high" },
          }
        );

        expect(renderedRows(component)).toStrictEqual([
          "✓ Spawned /root/review",
          "model provider/child · thinking off",
        ]);

        for (const width of [1, 2, 20, 80]) {
          expect(
            component.render(width).every((line) => visibleWidth(line) <= width)
          ).toBe(true);
        }

        expect(result).toStrictEqual(original);
      }
    );

    it.each([undefined, null, {}, { model: 7, thinkingLevel: false }])(
      "does not invent settings for absent or malformed saved metadata: %j",
      (details) => {
        const component = agentRenderers("spawn_agent").renderResult(
          { ...jsonToolResult({ task_name: "/root/review" }), details },
          { expanded: false, isPartial: false },
          theme,
          toolRenderContext()
        );

        expect(renderedRows(component).join("\n")).toBe(
          "✓ Spawned /root/review"
        );
      }
    );

    it("sanitizes saved model and thinking metadata", () => {
      const component = agentRenderers("spawn_agent").renderResult(
        {
          ...jsonToolResult({ task_name: "/root/review" }),
          details: {
            model: "provider/child\u001B[2J\nforged",
            thinkingLevel: "high\u001B[2J",
          },
        },
        { expanded: false, isPartial: false },
        theme,
        toolRenderContext()
      );

      const rows = renderedRows(component);
      expect(rows).toStrictEqual([
        "✓ Spawned /root/review",
        "model provider/child forged · thinking high",
      ]);
    });

    it("renders queued acknowledgements without inventing completion", () => {
      for (const name of ["send_message", "followup_task"] as const) {
        const result = {
          content: [{ type: "text" as const, text: "" }],
          details: {},
        };

        const text = renderedRows(
          agentRenderers(name).renderResult(
            result,
            { expanded: false, isPartial: false },
            theme,
            toolRenderContext()
          )
        ).join("\n");

        expect(text).toMatch(/queued|submitted/u);
        expect(text).not.toContain("completed");

        const partial = renderedRows(
          agentRenderers(name).renderResult(
            result,
            { expanded: false, isPartial: true },
            theme,
            toolRenderContext({ isPartial: true })
          )
        ).join("\n");

        expect(partial).toBe("● working");
      }
    });

    it("distinguishes previous status and wait activity from completion", () => {
      expect(
        renderedRows(
          render("interrupt_agent", { previous_status: "running" })
        ).join("\n")
      ).toBe("■ Interrupted · was ● running");
      expect(
        renderedRows(
          render("interrupt_agent", { previous_status: "not_found" })
        ).join("\n")
      ).toBe("Nothing to interrupt · was ✗ not found");
      expect(
        renderedRows(
          render("wait_agent", {
            message: "Wait interrupted by new input.",
            timed_out: false,
          })
        )
      ).toStrictEqual([
        "✓ Activity received",
        "Wait interrupted by new input.",
      ]);
      expect(
        renderedRows(
          render("wait_agent", { message: "Wait timed out.", timed_out: true })
        )
      ).toStrictEqual(["◷ Wait timed out", "Wait timed out."]);
    });

    it("bounds agent lists and shows stored answer detail when expanded", () => {
      const value = {
        agents: Array.from({ length: 20 }, (_, i) => ({
          agent_name: `/root/worker_${i}`,
          agent_status: { completed: "Detailed answer" },
        })),
      };

      const collapsed = renderedRows(render("list_agents", value));
      expect(collapsed.length).toBeLessThanOrEqual(10);
      expect(collapsed.join("\n")).not.toContain("Detailed answer");
      const expandedRows = renderedRows(render("list_agents", value, true));
      // Count, root, then one status and one answer per agent.
      expect(expandedRows).toHaveLength(42);
      const expanded = expandedRows.join("\n");
      expect(expanded).toContain("worker_19");
      expect(expanded).toContain("Detailed answer");
    });

    it("renders each expanded identity once with its own status and optional answer", () => {
      const agents: JsonValue[] = [
        { agent_name: "/root/running", agent_status: "running" },
        { agent_name: "/root/done", agent_status: { completed: "Answer" } },
        { agent_name: "/root/null", agent_status: { completed: null } },
        { agent_name: "/root/empty", agent_status: { completed: "" } },
        { agent_name: "/root/error", agent_status: { errored: "Failure" } },
        { agent_name: "/root/blank_error", agent_status: { errored: "" } },
        { agent_name: "/root/stopped", agent_status: "interrupted" },
      ];

      expect(
        renderedRows(render("list_agents", { agents }, true))
      ).toStrictEqual([
        "7 agents · 1 running",
        "root",
        "├─ running ● running",
        "├─ done ✓ completed",
        "│    Answer",
        "├─ null ✓ completed",
        "├─ empty ✓ completed",
        "├─ error ✗ errored",
        "│    Failure",
        "├─ blank_error ✗ errored",
        "└─ stopped ■ interrupted",
      ]);
      expect(
        renderedRows(render("list_agents", { agents: [] }, true))
      ).toStrictEqual(["0 agents"]);
    });

    it("draws nested agents under their parents, anchoring a scoped listing at the root", () => {
      const agents: JsonValue[] = [
        { agent_name: "/root/a/b", agent_status: "running" },
        { agent_name: "/root/a/b/c", agent_status: { completed: null } },
        { agent_name: "/root/a/d", agent_status: "interrupted" },
      ];

      expect(renderedRows(render("list_agents", { agents }))).toStrictEqual([
        "3 agents · 1 running",
        "root",
        "└─ a",
        "   ├─ b ● running",
        "   │  └─ c ✓ completed",
        "   └─ d ■ interrupted",
      ]);
    });

    it("colours tree names as their own spans, since a theme colour ends at the next reset", () => {
      const tagged = createIdentityTheme();
      tagged.fg = (color, text) => `[${color}:${text}]`;

      const rows = renderedRows(
        agentRenderers("list_agents").renderResult(
          jsonToolResult({
            agents: [{ agent_name: "/root/a/b", agent_status: "running" }],
          }),
          { expanded: false, isPartial: false },
          tagged,
          toolRenderContext()
        )
      );

      expect(rows).toContain("[dim:][muted:root]");
      expect(rows).toContain("[dim:└─ ][muted:a]");
      expect(rows).toContain(
        "[dim:   └─ ][accent:b] [accent:●] [accent:running]"
      );
    });

    it("shows a listing whose names are not agent paths as text instead of dropping them", () => {
      const rows = renderedRows(
        agentRenderers("list_agents").renderResult(
          jsonToolResult({
            agents: [
              { agent_name: "worker", agent_status: "running" },
              { agent_name: "/root/ok", agent_status: "running" },
            ],
          }),
          { expanded: false, isPartial: false },
          createIdentityTheme(),
          toolRenderContext()
        )
      ).join("");

      expect(rows).toContain('"agent_name":"worker"');
      expect(rows).toContain('"agent_name":"/root/ok"');
    });

    it("repeats a result's target in plain text, leaving accent to the call line", () => {
      const tagged = createIdentityTheme();
      tagged.fg = (color, text) => `[${color}:${text}]`;

      const row = renderedRows(
        agentRenderers("send_message").renderResult(
          { content: [{ text: "", type: "text" }], details: {} },
          { expanded: false, isPartial: false },
          tagged,
          { ...toolRenderContext(), args: { message: "hi", target: "worker" } }
        )
      ).join("\n");

      expect(row).toBe("[success:✓ Message queued] [text:worker]");
    });

    it("bounds hostile and partially streamed call arguments", () => {
      const renderer = agentRenderers("spawn_agent").renderCall;

      const args = {
        task_name: "review\u001B[2J",
        message: `${"x".repeat(1000)}END`,
        model: "model",
      };

      const component = renderer(args, theme, toolRenderContext());

      for (const width of [1, 2, 20, 80]) {
        const rows = component.render(width);
        expect(rows.length).toBeLessThanOrEqual(4);
        expect(rows.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(rows.join("\n")).not.toContain("\u001B[2J");
      }

      expect(
        renderedRows(
          renderer(args, theme, toolRenderContext({ expanded: true }))
        ).join("\n")
      ).toContain("END");

      expect(() =>
        renderedRows(
          renderer(
            { message: null, task_name: 7 },
            theme,
            toolRenderContext({ isPartial: true })
          )
        )
      ).not.toThrow();
    });

    it.each<JsonValue>([
      { task_name: 4 },
      { previous_status: { completed: 7 } },
      { agents: [{ agent_name: "bad", agent_status: { errored: false } }] },
      { timed_out: "false" },
    ])("preserves malformed result fields as raw text", (value) => {
      const original = structuredClone(value);
      expect(
        renderedRows(render("spawn_agent", value, true), 2000).join("\n")
      ).toBe(JSON.stringify(value));
      expect(value).toStrictEqual(original);
    });

    it("renders stored calls and results of retired tool shapes as plain text", () => {
      const stored = { agent_id: "uuid", nickname: "Atlas" };
      expect(renderedRows(render("spawn_agent", stored), 2000).join("\n")).toBe(
        JSON.stringify(stored)
      );
      expect(
        renderedRows(
          render("send_message", { submission_id: "s_1" }),
          2000
        ).join("\n")
      ).toBe(JSON.stringify({ submission_id: "s_1" }));

      const call = renderedRows(
        agentRenderers("spawn_agent").renderCall(
          {
            items: [
              { type: "image", image_url: "data:image/png;base64,SECRET" },
            ],
            fork_context: true,
          },
          theme,
          toolRenderContext({ expanded: true })
        )
      ).join("\n");

      expect(call).toBe("spawn_agent");
    });

    it("joins text blocks and ignores images when falling back for old results and errors", () => {
      const renderer = agentRenderers("send_message").renderResult;

      const result = {
        content: [
          { type: "text" as const, text: "Old error\u001B[2J" },
          { type: "image" as const, data: "", mimeType: "image/png" },
          { type: "text" as const, text: "More detail" },
        ],
        details: undefined,
      };

      for (const isError of [false, true]) {
        expect(
          renderedRows(
            renderer(
              result,
              { expanded: false, isPartial: false },
              theme,
              toolRenderContext({ isError })
            )
          ).join("\n")
        ).toBe("Old error\nMore detail");
      }
    });
  });

  describe(mailRenderer, () => {
    it("shows a final answer as a card naming its sender, without the envelope", () => {
      const answer = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join(
        "\n\n"
      );

      const base = {
        from: "/root/research",
        kind: "FINAL_ANSWER",
        to: "/root",
      } as const;

      const collapsed = card({ ...base, content: answer });

      expect(collapsed[0]).toBe("✓ research finished · /root/research");
      expect(collapsed.join("\n")).toContain("line 1");
      expect(collapsed.join("\n")).not.toContain("line 12");
      expect(collapsed.join("\n")).not.toContain("Message Type");
      expect(card({ ...base, content: answer }, true).join("\n")).toContain(
        "line 12"
      );
    });

    it("labels a task steered into a running turn as a task", () => {
      expect(
        card({
          content: "Also run lint",
          from: "/root",
          kind: "NEW_TASK",
          to: "/root/worker",
        })[0]
      ).toBe("▸ task from root · /root");
    });

    it("marks a failed turn by its recorded outcome, not its text, and keeps plain messages quiet", () => {
      const failure = errorCompletion("Rate limited");

      const base = {
        content: failure,
        from: "/root/docs",
        kind: "FINAL_ANSWER",
        to: "/root",
      } as const;

      expect(card({ ...base, failed: true })[0]).toBe(
        "✗ docs failed · /root/docs"
      );
      // An answer that merely quotes the failure wording finished.
      expect(card(base)[0]).toBe("✓ docs finished · /root/docs");
      expect(
        card({
          content: "Halfway there",
          from: "/root/a/b",
          kind: "MESSAGE",
          to: "/root/a",
        })
      ).toStrictEqual(["✉ message from b · /root/a/b", "  Halfway there"]);
    });
  });
});
