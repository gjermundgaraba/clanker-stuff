// The consumer mirrors the SDK's pump, `for await (m of stream) await transport.write(m)`:
// the ack contract holds only against that shape.

import { setTimeout as delay } from "node:timers/promises";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";

import { makePromptStream, userMessage } from "../../query/prompt-stream.js";

const text = (message: SDKUserMessage): string => {
  const { content } = message.message;

  if (typeof content !== "string") {
    throw new TypeError("expected a text prompt");
  }

  return content;
};

const pump = async (
  stream: AsyncIterable<SDKUserMessage>,
  write: (message: SDKUserMessage) => Promise<void> | void
): Promise<void> => {
  for await (const message of stream) {
    await write(message);
  }
};

const tick = async (): Promise<void> => {
  await delay(10);
};

describe("makePromptStream", () => {
  it("resolves the ack only after the write completes", async () => {
    const ps = makePromptStream();
    const written: string[] = [];

    const { promise: writeGate, resolve: releaseWrite } =
      Promise.withResolvers<undefined>();

    const pumping = pump(ps.stream, async (message) => {
      written.push(text(message));
      await writeGate;
    });

    let acked = false;

    const ack = (async () => {
      await ps.push(userMessage("steer"));
      acked = true;
    })();

    await tick();

    // The write is in flight: an ack now would let a caller release a tool result
    // before the steer reached stdin.
    expect(written).toStrictEqual(["steer"]);
    expect(acked).toBe(false);

    releaseWrite(undefined);
    await ack;
    ps.end();
    await pumping;

    expect(acked).toBe(true);
  });

  it("delivers messages in push order and ends after draining", async () => {
    const ps = makePromptStream();
    const written: string[] = [];

    const pumping = pump(ps.stream, (message) => {
      written.push(text(message));
    });

    await ps.push(userMessage("first"));
    await ps.push(userMessage("second"));
    ps.end();
    await pumping;

    expect(written).toStrictEqual(["first", "second"]);
  });

  it("rejects a push after end instead of hanging", async () => {
    const ps = makePromptStream();
    const pumping = pump(ps.stream, () => {});

    ps.end();
    await pumping;

    await expect(ps.push(userMessage("late"))).rejects.toThrow(/closed/u);
  });

  it("settles queued and in-flight acks on failure", async () => {
    const ps = makePromptStream();
    // A write that never finishes: the CLI died mid-write.
    const { promise: stalled } = Promise.withResolvers<undefined>();

    const pumping = pump(ps.stream, async () => {
      await stalled;
    });

    const inflight = expect(ps.push(userMessage("inflight"))).rejects.toThrow(
      /query ended/u
    );

    await tick();

    const queued = expect(ps.push(userMessage("queued"))).rejects.toThrow(
      /query ended/u
    );

    ps.fail(new Error("query ended"));

    await inflight;
    await queued;
    await expect(ps.push(userMessage("after"))).rejects.toThrow(/query ended/u);

    void pumping;
  });

  it("settles the ack when the consumer abandons the stream", async () => {
    const ps = makePromptStream();
    const pulled = ps.stream.next();

    const ack = expect(ps.push(userMessage("abandoned"))).rejects.toThrow(
      /closed/u
    );

    await pulled;
    // What `break` in the SDK's pump does.
    await ps.stream.return(undefined);
    await ack;
    // Nothing is left to drain the queue, so a later push must reject, not park.
    await expect(ps.push(userMessage("later"))).rejects.toThrow(/closed/u);
  });

  it("settles every queued ack when the consumer abandons the stream", async () => {
    const ps = makePromptStream();
    const pulled = ps.stream.next();

    const first = expect(ps.push(userMessage("in flight"))).rejects.toThrow(
      /closed/u
    );

    const second = expect(
      ps.push(userMessage("queued behind it"))
    ).rejects.toThrow(/closed/u);

    await pulled;
    await ps.stream.return(undefined);
    await first;
    await second;
  });

  it("keeps the first failure rather than the last", async () => {
    const ps = makePromptStream();

    const pumping = expect(pump(ps.stream, () => {})).rejects.toThrow(
      /CLI exited with code 1/u
    );

    const queued = expect(ps.push(userMessage("queued"))).rejects.toThrow(
      /CLI exited with code 1/u
    );

    // The provider reports the real cause, then its finally fails the stream again.
    ps.fail(new Error("CLI exited with code 1"));
    ps.fail(new Error("query ended"));

    await queued;
    await expect(ps.push(userMessage("after"))).rejects.toThrow(
      /CLI exited with code 1/u
    );
    await pumping;
  });
});

describe("userMessage", () => {
  it("carries priority and no uuid", () => {
    const message = userMessage([{ type: "text", text: "steer" }], "next");

    expect(message).toStrictEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "steer" }] },
      parent_tool_use_id: null,
      priority: "next",
    });
    // A uuid makes Claude Code's stdin loop look the message up in the session.
    expect(message).not.toHaveProperty("uuid");
  });
});
