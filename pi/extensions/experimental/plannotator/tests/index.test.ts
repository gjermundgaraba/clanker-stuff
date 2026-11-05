import { describe, expect, it } from "vite-plus/test";

import { setup } from "./helpers.js";

describe("plannotator host", () => {
  it("does not start the CLI for a command that races shutdown", async () => {
    const { ctx, host, starter } = setup();

    const command = host.runCommand("plannotator-review", "", ctx);
    await host.emitSessionShutdown(ctx);
    await command;

    expect(starter).not.toHaveBeenCalled();
    expect(host.getNotifications()).toStrictEqual([]);
  });
});
