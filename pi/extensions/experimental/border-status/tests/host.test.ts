import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { createInboxStatus } from "../../../ask-question/status.js";
import {
  createBorderStatusClient,
  BORDER_READY_EVENT,
  BORDER_READY_REQUEST_EVENT,
  BORDER_UNAVAILABLE_EVENT,
  BORDER_STATUS_EVENT,
  BorderReadySchema,
} from "@clanker-stuff/border-status-protocol";
import type { BorderReady } from "@clanker-stuff/border-status-protocol";
import {
  FOOTER_PROTOCOL_VERSION,
  FOOTER_ICON_PREFERENCE_EVENT,
} from "@clanker-stuff/footer-protocol";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import extension from "../index.js";
import { createEditor } from "./fixtures.js";

it.each([true, false])(
  "supports independent producers and load order, producers first=%s",
  async (first) => {
    const host = createExtensionHost(extension);
    await host.ready;
    const ctx = host.createContext();
    const a = createBorderStatusClient(host, { owner: "a" });
    const b = createBorderStatusClient(host, { owner: "b" });
    const publish = () => {
      a.attach(ctx);
      b.attach(ctx);
      a.set("same", { text: "A" });
      b.set("same", { text: "B" });
    };
    if (first) publish();
    await host.emitSessionStart(ctx);
    const editor = createEditor(host);
    editor.render(80);
    await Promise.resolve();
    if (!first) publish();
    const border = () => stripTerminalSequences(editor.render(80)[0]!);
    expect(border()).toContain("A · B");
    a.set("same", { text: "new" });
    expect(border()).toContain("new · B");
    a.clearAll();
    expect(border()).not.toContain("new");
    expect(border()).toContain("B");
    await host.emitSessionShutdown(ctx);
    expect(a.available).toBe(false);
    expect(border()).toBe("─".repeat(80));
    a.dispose();
    b.dispose();
  },
);

describe("host lifecycle and fonts", () => {
  it("ignores invalid and stale messages, clears on navigation, and republishes scoped state", async () => {
    const host = createExtensionHost(extension);
    await host.ready;
    const ctx = host.createContext();
    let ready: BorderReady | undefined;
    host.events.on(BORDER_READY_EVENT, (value) => {
      if (Value.Check(BorderReadySchema, value)) ready = value;
    });
    await host.emitSessionStart(ctx);
    const editor = createEditor(host);
    editor.render(80);
    await Promise.resolve();
    const old = ready!;
    const client = createBorderStatusClient(host, { owner: "test" });
    client.attach(ctx);
    client.set("x", { text: "old" });
    const next = host.createContext({ sessionManager: { getLeafId: () => "new-branch" } });
    await host.emit("session_tree", { type: "session_tree", newLeafId: "new-branch" }, next);
    const border = () => stripTerminalSequences(editor.render(80)[0]!);
    expect(border()).not.toContain("old");
    host.events.emit(BORDER_STATUS_EVENT, {
      ...old,
      owner: "test",
      key: "x",
      type: "set",
      status: { text: "stale" },
    });
    host.events.emit(BORDER_STATUS_EVENT, {
      ...ready,
      owner: "test",
      key: "x",
      type: "set",
      status: { text: "\x1b[31m" },
    });
    expect(border()).toBe("─".repeat(80));
    client.attach(next, "new-branch");
    client.set("x", { text: "3", icon: { nerd: "\uF0E0", unicode: "✉", ascii: "mail" } });
    expect(border()).toContain("✉ 3");
    host.events.emit(FOOTER_ICON_PREFERENCE_EVENT, { version: 1, iconFamily: "nerd" });
    host.events.emit(FOOTER_ICON_PREFERENCE_EVENT, {
      protocol: 99,
      type: "icon-preference",
      iconFamily: "nerd",
    });
    host.events.emit(FOOTER_ICON_PREFERENCE_EVENT, {
      protocol: FOOTER_PROTOCOL_VERSION,
      type: "icon-preference",
      iconFamily: "nerd",
      extra: true,
    });
    expect(border()).toContain("✉ 3");

    host.events.emit(FOOTER_ICON_PREFERENCE_EVENT, {
      protocol: FOOTER_PROTOCOL_VERSION,
      type: "icon-preference",
      iconFamily: "nerd",
    });
    expect(border()).toContain("\uF0E0 3");
    await host.runCommand("border-status", "icons ascii", next);
    host.events.emit(FOOTER_ICON_PREFERENCE_EVENT, {
      protocol: FOOTER_PROTOCOL_VERSION,
      type: "icon-preference",
      iconFamily: "unicode",
    });
    expect(border()).toContain("mail 3");
    await host.runCommand("border-status", "icons inherit", next);
    expect(border()).toContain("✉ 3");
    client.dispose();
    await host.emitSessionShutdown(next);
  });
});

it("does not revive cleared statuses when an editor factory temporarily becomes unsupported", async () => {
  const host = createExtensionHost(extension);
  await host.ready;
  const ctx = host.createContext();
  // Seed a real default editor factory from a first host start.
  await host.emitSessionStart(ctx);
  const compatible = createEditor(host);
  await host.emitSessionShutdown(ctx);
  let supported = true;
  ctx.ui.setEditorComponent(() =>
    supported
      ? compatible
      : {
          render: () => ["foreign"],
          invalidate() {},
          handleInput() {},
          getText: () => "",
          setText() {},
        },
  );
  await host.emitSessionStart(ctx);
  const client = createBorderStatusClient(host, { owner: "test" });
  client.attach(ctx);
  let editor = createEditor(host);
  editor.render(80);
  await Promise.resolve();
  client.set("x", { text: "old-status" });
  expect(stripTerminalSequences(editor.render(80)[0]!)).toContain("old-status");
  supported = false;
  createEditor(host);
  await Promise.resolve();
  expect(client.available).toBe(false);
  client.clear("x");
  supported = true;
  editor = createEditor(host);
  editor.render(80);
  await Promise.resolve();
  expect(client.available).toBe(true);
  expect(stripTerminalSequences(editor.render(80)[0]!)).not.toContain("old-status");
  client.dispose();
  await host.emitSessionShutdown(ctx);
});

it("keeps the inbox widget through border compatibility changes, overflow and editor replacement", async () => {
  class AlternateEditor extends CustomEditor {
    unusual = true;
    protected override renderTopBorder(width: number, hidden: number): string {
      return this.unusual ? "custom".padEnd(width, " ") : super.renderTopBorder(width, hidden);
    }
  }
  let inbox: ReturnType<typeof createInboxStatus> | undefined;
  const host = createExtensionHost((pi) => {
    extension(pi);
    inbox = createInboxStatus(pi);
  });
  await host.ready;
  const ctx = host.createContext();
  let current: AlternateEditor | undefined;
  ctx.ui.setEditorComponent((tui, theme, keys) => {
    current = new AlternateEditor(tui, theme, keys);
    return current;
  });
  await host.emitSessionStart(ctx);
  inbox!.attach(ctx);
  inbox!.update(2, 0);
  const editor = createEditor(host);
  const line = () => stripTerminalSequences(editor.render(80)[0]!);
  expect(host.getWidget("questionnaires")).toContain("2 questionnaires");
  line();
  await Promise.resolve();
  expect(host.getWidget("questionnaires")).toContain("2 questionnaires");
  current!.unusual = false;
  line();
  await Promise.resolve();
  expect(host.getWidget("questionnaires")).toContain("2 questionnaires");
  expect(line()).toContain("✉ 2");
  editor.render(5);
  await Promise.resolve();
  expect(host.getWidget("questionnaires")).toContain("2 questionnaires");
  const competitor = createBorderStatusClient(host, { owner: "competitor" });
  competitor.attach(ctx);
  competitor.set("busy", { text: "competing", priority: 1000 });
  const crowded = stripTerminalSequences(editor.render(16)[0]!);
  expect(crowded).toContain("competing");
  expect(crowded).not.toContain("✉");
  await Promise.resolve();
  expect(host.getWidget("questionnaires")).toContain("2 questionnaires");
  competitor.dispose();
  current!.unusual = true;
  line();
  await Promise.resolve();
  expect(host.getWidget("questionnaires")).toContain("2 questionnaires");
  inbox!.update(1, 0);
  current!.unusual = false;
  line();
  await Promise.resolve();
  expect(line()).toContain("✉ 1");
  expect(host.getWidget("questionnaires")).toContain("1 questionnaire");
  // Replacement bypasses the border factory entirely.
  ctx.ui.setEditorComponent((tui, theme, keys) => new CustomEditor(tui, theme, keys));
  const replacement = createEditor(host);
  expect(stripTerminalSequences(replacement.render(80)[0]!)).not.toContain("✉");
  await Promise.resolve();
  expect(host.getWidget("questionnaires")).toContain("1 questionnaire");
  inbox!.dispose();
  expect(host.getWidget("questionnaires")).toBeUndefined();
  await host.emitSessionShutdown(ctx);
});

it("preserves availability, generation and entries when reusing the active editor", async () => {
  const host = createExtensionHost(extension);
  await host.ready;
  const ctx = host.createContext();
  let cached: CustomEditor | undefined;
  ctx.ui.setEditorComponent((tui, theme, keys) => {
    cached ??= new CustomEditor(tui, theme, keys);
    return cached;
  });
  const announcements: BorderReady[] = [];
  const unavailable: unknown[] = [];
  host.events.on(BORDER_READY_EVENT, (value) => {
    if (Value.Check(BorderReadySchema, value)) announcements.push(value);
  });
  host.events.on(BORDER_UNAVAILABLE_EVENT, (value) => unavailable.push(value));
  await host.emitSessionStart(ctx);
  const editor = createEditor(host);
  editor.render(80);
  await Promise.resolve();
  const generation = announcements.at(-1)!.instanceId;
  // Publish directly: a client replay must not mask a cleared host registry.
  host.events.emit(BORDER_STATUS_EVENT, {
    ...announcements.at(-1)!,
    owner: "test",
    key: "cached",
    type: "set",
    status: { text: "retained" },
  });
  expect(createEditor(host)).toBe(editor);
  await Promise.resolve();
  expect(unavailable).toEqual([]);
  expect(announcements).toHaveLength(1);
  host.events.emit(BORDER_READY_REQUEST_EVENT, { version: 1 });
  expect(announcements).toHaveLength(2);
  expect(announcements.at(-1)!.instanceId).toBe(generation);
  expect(stripTerminalSequences(editor.render(80)[0]!)).toContain("retained");
  await host.emitSessionShutdown(ctx);
});

it("admits late high-priority entries beyond 128 statuses and reveals retained entries on clear", async () => {
  const host = createExtensionHost(extension);
  await host.ready;
  const ctx = host.createContext();
  await host.emitSessionStart(ctx);
  const editor = createEditor(host);
  editor.render(80);
  await Promise.resolve();
  const client = createBorderStatusClient(host, { owner: "many" });
  client.attach(ctx);
  for (let i = 0; i < 128; i++) client.set(String(i), { text: "background", priority: -1 });
  client.set("late", { text: "retained", priority: 99 });
  client.set("inbox", { text: "attention", priority: 100 });
  const line = () => stripTerminalSequences(editor.render(16)[0]!);
  expect(line()).toContain("attention");
  expect(line()).not.toContain("retained");
  client.clear("inbox");
  expect(line()).toContain("retained");
  client.dispose();
  expect(line()).toBe("─".repeat(16));
  await host.emitSessionShutdown(ctx);
});
