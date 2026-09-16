import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createIdentityTheme } from "../../../../tests/harness/tui.js";
import {
  jsonToolResult,
  renderedRows,
  toolRenderContext,
} from "../../../../tests/harness/tool-rendering.js";
import { agentRenderers } from "../renderers.js";

const theme = createIdentityTheme();
const render = (name: string, value: unknown, expanded = false) =>
  agentRenderers(name).renderResult(
    jsonToolResult(value),
    { expanded, isPartial: false },
    theme,
    toolRenderContext({ expanded }),
  );
beforeAll(() => initTheme("dark"));

describe("agent presentation", () => {
  it("refreshes the previous-status prefix along with the status on invalidation", () => {
    const changing = createIdentityTheme();
    let color = "\x1b[31m";
    changing.fg = (_name, value) => color + value + "\x1b[0m";
    const component = agentRenderers("interrupt_agent").renderResult(
      jsonToolResult({ previous_status: "running" }),
      { expanded: false, isPartial: false },
      changing,
      toolRenderContext(),
    );
    expect(component.render(80).join("\n")).toContain("\x1b[31mPrevious status");
    color = "\x1b[32m";
    component.invalidate();
    const refreshed = component.render(80).join("\n");
    expect(refreshed).toContain("\x1b[32mPrevious status");
    expect(refreshed).not.toContain("\x1b[31m");
  });
  it("summarizes V1 and V2 spawn results with identity and nickname", () => {
    expect(
      renderedRows(render("spawn_agent", { agent_id: "uuid", nickname: "Atlas" })).join("\n"),
    ).toBe("✓ Spawned uuid · Atlas");
    const result = {
      ...jsonToolResult({ task_name: "/root/review" }),
      details: { nickname: "Atlas" },
    };
    const original = structuredClone(result);
    expect(
      renderedRows(
        agentRenderers("spawn_agent").renderResult(
          result,
          { expanded: false, isPartial: false },
          theme,
          toolRenderContext(),
        ),
      ).join("\n"),
    ).toBe("✓ Spawned /root/review · Atlas");
    expect(result).toEqual(original);
  });
  it("renders queued acknowledgements without inventing completion", () => {
    for (const name of ["send_message", "followup_task"]) {
      const result = { content: [{ type: "text" as const, text: "" }], details: {} };
      const text = renderedRows(
        agentRenderers(name).renderResult(
          result,
          { expanded: false, isPartial: false },
          theme,
          toolRenderContext(),
        ),
      ).join("\n");
      expect(text).toMatch(/queued|submitted/u);
      expect(text).not.toContain("completed");
      const partial = renderedRows(
        agentRenderers(name).renderResult(
          result,
          { expanded: false, isPartial: true },
          theme,
          toolRenderContext({ isPartial: true }),
        ),
      ).join("\n");
      expect(partial).toBe("● working");
    }
    expect(renderedRows(render("send_input", { submission_id: "s_1" })).join("\n")).toBe(
      "✓ Input submitted s_1",
    );
  });
  it("shows V1 final answers and errors with expandable text", () => {
    const answer = Array.from({ length: 20 }, (_, i) => `answer ${i}`).join("\n");
    const value = {
      status: { uuid: { completed: answer }, failed: { errored: "No access" } },
      timed_out: false,
    };
    const collapsed = renderedRows(render("wait_agent", value)).join("\n");
    expect(collapsed).toContain("uuid · ✓ completed");
    expect(collapsed).toContain("failed · ✗ errored");
    expect(collapsed).toContain("No access");
    expect(collapsed).not.toContain("answer 19");
    expect(renderedRows(render("wait_agent", value, true)).join("\n")).toContain("answer 19");
    expect(renderedRows(render("wait_agent", { status: {}, timed_out: true })).join("\n")).toBe(
      "Wait timed out",
    );
  });
  it("distinguishes previous status and mailbox activity from completion", () => {
    expect(renderedRows(render("interrupt_agent", { previous_status: "running" })).join("\n")).toBe(
      "Previous status · ● running",
    );
    expect(renderedRows(render("close_agent", { previous_status: "not_found" })).join("\n")).toBe(
      "Previous status · ✗ not found",
    );
    expect(
      renderedRows(
        render("wait_agent", { message: "User input received.", timed_out: false }),
      ).join("\n"),
    ).toContain("User input received.");
    expect(renderedRows(render("resume_agent", { status: "interrupted" })).join("\n")).toContain(
      "interrupted",
    );
  });
  it("bounds resident lists and shows stored answer detail when expanded", () => {
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
    expect(expandedRows).toHaveLength(41); // Count, then one status and one answer per agent.
    const expanded = expandedRows.join("\n");
    expect(expanded).toContain("worker_19");
    expect(expanded).toContain("Detailed answer");
  });
  it("renders each expanded identity once with its own status and optional answer", () => {
    const agents = [
      { agent_name: "/root/running", agent_status: "running" },
      { agent_name: "/root/done", agent_status: { completed: "Answer" } },
      { agent_name: "/root/null", agent_status: { completed: null } },
      { agent_name: "/root/empty", agent_status: { completed: "" } },
      { agent_name: "/root/error", agent_status: { errored: "Failure" } },
      { agent_name: "/root/blank_error", agent_status: { errored: "" } },
      { agent_name: "/root/pending", agent_status: "pending_init" },
      { agent_name: "/root/stopped", agent_status: "shutdown" },
    ];
    expect(renderedRows(render("list_agents", { agents }, true))).toEqual([
      "8 resident agents",
      "/root/running · ● running",
      "/root/done · ✓ completed",
      "Answer",
      "/root/null · ✓ completed",
      "/root/empty · ✓ completed",
      "/root/error · ✗ errored",
      "Failure",
      "/root/blank_error · ✗ errored",
      "/root/pending · ● pending init",
      "/root/stopped · ■ shutdown",
    ]);
    expect(renderedRows(render("list_agents", { agents: [] }, true))).toEqual([
      "0 resident agents",
    ]);
  });
  it("bounds hostile and partially streamed call arguments, without dumping images", () => {
    const renderer = agentRenderers("spawn_agent").renderCall;
    const args = {
      task_name: "review\u001b[2J",
      message: "x".repeat(1000) + "END",
      model: "model",
    };
    const component = renderer(args, theme, toolRenderContext());
    for (const width of [1, 2, 20, 80]) {
      const rows = component.render(width);
      expect(rows.length).toBeLessThanOrEqual(4);
      expect(rows.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(rows.join("\n")).not.toContain("\u001b[2J");
    }
    expect(
      renderedRows(renderer(args, theme, toolRenderContext({ expanded: true }))).join("\n"),
    ).toContain("END");
    const items = {
      items: [
        { type: "image", image_url: "data:image/png;base64,SECRET" },
        { type: "text", text: "inspect image" },
      ],
    };
    const text = renderedRows(renderer(items, theme, toolRenderContext({ expanded: true }))).join(
      "\n",
    );
    expect(text).toContain("[image]");
    expect(text).not.toContain("SECRET");
    expect(() =>
      renderedRows(
        renderer({ message: null, task_name: 7 }, theme, toolRenderContext({ isPartial: true })),
      ),
    ).not.toThrow();
  });
  it("falls back safely for old results and failed messaging", () => {
    const renderer = agentRenderers("send_message").renderResult;
    const result = {
      content: [{ type: "text" as const, text: "Old error\u001b[2J" }],
      details: undefined,
    };
    for (const isError of [false, true])
      expect(
        renderedRows(
          renderer(
            result,
            { expanded: false, isPartial: false },
            theme,
            toolRenderContext({ isError }),
          ),
        ).join("\n"),
      ).toBe("Old error");
  });
});
