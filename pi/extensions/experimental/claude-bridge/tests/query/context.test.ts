import { describe, expect, it } from "vite-plus/test";

import { QueryContext } from "../../query/context.js";
import { testModel } from "../helpers.js";

describe("QueryContext", () => {
  it("refuses turnBlocks before a turn starts", () => {
    expect(() => new QueryContext().turnBlocks).toThrow(
      "turnBlocks accessed before resetTurnState",
    );
  });

  // Stream state left over from the last turn would make the next one drop or mis-close
  // its blocks, while turnToolCallIds must survive: results route to this query while its
  // handlers are still pending.
  it("resets per-turn state but keeps the tool call ids results route by", () => {
    const c = new QueryContext();

    c.resetTurnState(testModel());
    c.turnBlocks.push({ type: "text", text: "earlier" });
    c.turnStarted = true;
    c.turnSawStreamEvent = true;
    c.turnSawToolCall = true;
    c.turnStreamMessageId = "msg_1";
    c.turnStreamOpen = true;
    c.turnStreamBlockStart = 1;
    c.openBlocks.set({ type: "text", text: "" }, { index: 0, partialJson: "" });
    c.turnToolCallIds = ["toolu_1", "toolu_2"];

    c.resetTurnState(testModel());

    expect(c.turnOutput?.content).toEqual([]);
    expect(c.turnOutput?.stopReason).toBe("stop");
    expect(c.turnStarted).toBe(false);
    expect(c.turnSawStreamEvent).toBe(false);
    expect(c.turnSawToolCall).toBe(false);
    expect(c.turnStreamMessageId).toBeUndefined();
    expect(c.turnStreamOpen).toBe(false);
    expect(c.turnStreamBlockStart).toBe(0);
    expect(c.openBlocks.size).toBe(0);
    expect(c.turnToolCallIds).toEqual(["toolu_1", "toolu_2"]);
    // The block list the stream mapping appends to is the turn's own content.
    c.turnBlocks.push({ type: "text", text: "hello" });
    expect(c.turnOutput?.content).toEqual([{ type: "text", text: "hello" }]);
  });
});
