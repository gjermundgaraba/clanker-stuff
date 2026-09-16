import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { createCustomUiDriver, createKeybindings } from "../../../tests/harness/tui.js";
import extension from "../index.js";

const question = { questions: [{ title: "Which direction?", options: ["First", "Second"] }] };
const keybindings = createKeybindings({
  "tui.select.confirm": ["\r"],
  "tui.select.cancel": ["\u001b"],
  "tui.input.submit": ["\r"],
});

function setup(keys: string[] = []) {
  const host = createExtensionHost(extension);
  const driver = createCustomUiDriver({ keybindings, keys });
  const ctx = host.createContext({ ui: { custom: driver.custom } });
  return { host, driver, ctx };
}

describe("asynchronous user input", () => {
  it("sanitizes widgets and notifications without changing recorded messages or answers", async () => {
    const controls = "\u061c\u200e\u200f\u202e\u2066\u2069";
    const { host, ctx } = setup(["\t", "\r"]);
    await host.runTool(
      "request_user_input_async",
      { questions: [{ title: `Question${controls}`, options: [`Answer${controls}`] }] },
      { ctx },
    );
    expect(host.getWidget("async-questions")).toContain("Question");
    expect(JSON.stringify(host.getWidget("async-questions"))).not.toContain(controls);
    await host.runCommand("answers", "", ctx);
    expect(host.getSentUserMessages()[0].content).toContain(`Answer${controls}`);
    await host.runTool("send_message_to_user_async", { message: `Message${controls}` }, { ctx });
    expect(host.getAppendedEntries()[0]).toMatchObject({ data: { message: `Message${controls}` } });
    expect(host.getNotifications()).toContainEqual({ message: "Message", type: "info" });
  });
  it.each([
    { questions: [] },
    { questions: [{ title: "Choose", options: [] }] },
    { questions: [{ title: " \u0000 " }] },
    { questions: [{ title: "Choose", options: [" \u0000 "] }] },
    { questions: [{ title: "Choose", options: [" Other "] }] },
    { questions: [{ title: "Choose", options: ["First", " first\u0000 "] }] },
  ])("rejects invalid or ambiguous input before accepting a question: %j", async (params) => {
    const { host, ctx, driver } = setup();
    await expect(host.runTool("request_user_input_async", params, { ctx })).rejects.toThrow();
    expect(host.getWidget("async-questions")).toBeUndefined();
    expect(driver.component).toBeUndefined();
  });

  it("returns before UI input and requires explicit submission even with a suggested default", async () => {
    const { host, ctx, driver } = setup(["\t", "\r"]);
    expect((await host.runTool("request_user_input_async", question, { ctx })).content).toEqual([
      { type: "text", text: '{"accepted":true}' },
    ]);
    expect(driver.component).toBeUndefined();
    expect(host.getWidget("async-questions")).toContain("Which direction?");
    expect(host.getSentUserMessages()).toEqual([]);
    await host.runCommand("answers", "", ctx);
    expect(host.getSentUserMessages()).toEqual([
      {
        content: "User answered:\n- [Q1] Which direction? -> First",
        options: { deliverAs: "steer" },
      },
    ]);
    expect(host.getWidget("async-questions")).toBeUndefined();
  });

  it("dismisses without inventing an answer or aborting the agent", async () => {
    const { host, ctx } = setup(["\u001b"]);
    await host.runTool("request_user_input_async", question, { ctx });
    await host.runCommand("answers", "", ctx);
    expect(host.getSentUserMessages()).toEqual([]);
    expect(ctx.abort).not.toHaveBeenCalled();
    expect(host.getWidget("async-questions")).toBeUndefined();
  });

  it.each(["session_start", "session_tree", "session_shutdown"])(
    "discards pending questions on %s",
    async (event) => {
      const { host, ctx } = setup();
      await host.runTool("request_user_input_async", question, { ctx });
      await host.emit(event, {}, ctx);
      await host.runCommand("answers", "", ctx);
      expect(host.getSentUserMessages()).toEqual([]);
      expect(host.getWidget("async-questions")).toBeUndefined();
    },
  );

  it("closes active UI on lifecycle change without delivering stale input", async () => {
    const { host, ctx, driver } = setup();
    await host.runTool("request_user_input_async", question, { ctx });
    const answering = host.runCommand("answers", "", ctx);
    await expect.poll(() => driver.component).toBeDefined();
    await host.emit("session_tree", {}, ctx);
    await answering;
    driver.component?.handleInput?.("\t");
    driver.component?.handleInput?.("\r");
    expect(host.getSentUserMessages()).toEqual([]);
  });

  it("accepts free text and preserves it as user input", async () => {
    const { host, ctx } = setup(["\r", "hello", "\r", "\t", "\r"]);
    await host.runTool(
      "request_user_input_async",
      { questions: [{ title: "What else?" }] },
      { ctx },
    );
    await host.runCommand("answers", "", ctx);
    expect(host.getSentUserMessages()[0]?.content).toContain("hello");
  });

  it("removes an aborted request while leaving another pending", async () => {
    const { host, ctx } = setup();
    const abort = new AbortController();
    await host.runTool("request_user_input_async", question, {
      ctx,
      signal: abort.signal,
      toolCallId: "one",
    });
    await host.runTool("request_user_input_async", question, { ctx, toolCallId: "two" });
    abort.abort();
    expect(host.getWidget("async-questions")).toContain("1 pending question");
  });

  it("treats custom abort reasons as cancellation while choosing a pending request", async () => {
    const host = createExtensionHost(extension);
    const opened = Promise.withResolvers<void>();
    const ctx = host.createContext({
      ui: {
        select: async (_title, _options, options) => {
          opened.resolve();
          return await new Promise<string | undefined>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
              once: true,
            });
          });
        },
      },
    });
    const abort = new AbortController();
    await host.runTool("request_user_input_async", question, {
      ctx,
      signal: abort.signal,
      toolCallId: "one",
    });
    await host.runTool("request_user_input_async", question, { ctx, toolCallId: "two" });
    const answering = host.runCommand("answers", "", ctx);
    await opened.promise;
    abort.abort(new Error("Call cancelled"));
    await expect(answering).resolves.toBeUndefined();
    expect(host.getSentUserMessages()).toEqual([]);
  });

  it("displays an attention message without sending fabricated user input", async () => {
    const { host, ctx } = setup();
    await host.runTool("send_message_to_user_async", { message: "A decision is needed" }, { ctx });
    expect(host.getAppendedEntries()[0]).toMatchObject({
      customType: "async-attention",
      data: { message: "A decision is needed" },
    });
    expect(host.getSentMessages()).toEqual([]);
    expect(host.getSentUserMessages()).toEqual([]);
  });
});
