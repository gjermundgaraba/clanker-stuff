import { wireframe } from "@clanker-stuff/pi-shape-glyphs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../../tests/harness/extension-host.js";
import {
  createIdentityTheme,
  createMockTui,
} from "../../../../../tests/harness/tui.js";
import { Monitor } from "../../monitor.js";
import { emptyUsage } from "../../protocol.js";
import type { AgentNode } from "../../protocol.js";
import { BRAILLE_MARKS, orbMarks } from "../../ui/format.js";
import { Presenter } from "../../ui/presenter.js";

const node = (status: AgentNode["status"]): AgentNode => ({
  model: "provider/model",
  path: "/root/worker",
  sessionFile: "/sessions/worker.jsonl",
  startedAt: 0,
  status,
  thinking: "off",
  tools: [],
  usage: emptyUsage(),
});

const setup = (mode: ExtensionContext["mode"] = "tui") => {
  const monitor = new Monitor((cause) => {
    throw cause;
  });

  let nodes: AgentNode[] = [];

  const presenter = new Presenter({
    live: (): undefined => undefined,
    monitor,
    nodes: () => nodes,
    rootRunning: () => false,
  });

  const ctx = createExtensionHost(() => {}).createContext({ mode });
  const setWidget = vi.spyOn(ctx.ui, "setWidget");

  const set = (next: AgentNode[]) => {
    nodes = next;
    monitor.changed();
  };

  const shown = () => typeof setWidget.mock.calls.at(-1)?.[1] === "function";

  return { ctx, presenter, set, setWidget, shown };
};

describe(Presenter, () => {
  it("shows the widget while a child runs and removes it as soon as none does", () => {
    const { ctx, presenter, set, setWidget, shown } = setup();
    presenter.start(ctx, BRAILLE_MARKS);
    expect(setWidget).not.toHaveBeenCalled();

    set([node("running")]);
    expect(shown()).toBe(true);
    set([node("running")]);
    expect(setWidget).toHaveBeenCalledOnce();

    set([node("completed")]);
    expect(setWidget).toHaveBeenCalledTimes(2);
    expect(shown()).toBe(false);
  });

  it("draws running agents with the marks it was started with", () => {
    const { ctx, presenter, set, setWidget } = setup();
    const running = [node("running")];
    presenter.start(
      ctx,
      orbMarks(() => running)
    );
    set(running);

    const factory = setWidget.mock.calls.at(-1)?.[1];
    const theme = createIdentityTheme();

    const widget =
      typeof factory === "function"
        ? factory(createMockTui(), theme)
        : undefined;

    const text = widget?.render(100).join("\n") ?? "";
    widget?.dispose?.();
    presenter.stop();

    expect(
      wireframe("orb", "cyan", "dark").frames.some((frame) =>
        text.includes(frame)
      )
    ).toBe(true);
  });

  it("removes a visible widget on stop and stays silent outside the TUI", () => {
    const tui = setup();
    tui.presenter.start(tui.ctx, BRAILLE_MARKS);
    tui.set([node("running")]);
    tui.presenter.stop();
    expect(tui.shown()).toBe(false);
    tui.set([node("running")]);
    expect(tui.setWidget).toHaveBeenCalledTimes(2);

    const rpc = setup("rpc");
    rpc.presenter.start(rpc.ctx, BRAILLE_MARKS);
    rpc.set([node("running")]);
    expect(rpc.setWidget).not.toHaveBeenCalled();
  });
});
