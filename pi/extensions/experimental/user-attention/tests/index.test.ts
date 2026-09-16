import { describe, expect, it } from "vite-plus/test";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import extension from "../index.js";

describe("independent user attention", () => {
  it("keeps attention separate, without fabricated user input", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();
    await host.runTool("send_message_to_user_async", { message: "Synthetic attention" }, { ctx });
    expect(host.getAppendedEntries()[0]).toMatchObject({
      customType: "async-attention",
      data: { message: "Synthetic attention" },
    });
    expect(host.getSentUserMessages()).toEqual([]);
    expect(host.getSentMessages()).toEqual([]);
  });
  it("owns only the attention tool and its persisted entry renderer", async () => {
    const host = createExtensionHost(extension);
    await host.ready;
    expect([...host.getRegisteredTools().keys()]).toEqual(["send_message_to_user_async"]);
    const tool = host.getRegisteredTools().get("send_message_to_user_async")!.definition;
    expect(tool.renderCall).toBeTypeOf("function");
    expect(tool.renderResult).toBeTypeOf("function");
    expect(host.getEntryRenderer("async-attention")).toBeTypeOf("function");
    await expect(host.runTool("send_message_to_user_async", { message: "  " })).rejects.toThrow(
      "empty",
    );
    expect(host.getAppendedEntries()).toEqual([]);
  });
});
