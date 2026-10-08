import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { callTarget, Monitor, nextTrack, trackActivity } from "../monitor.js";
import type { Activity } from "../monitor.js";

const START: AgentSessionEvent = { type: "agent_start" };

const toolStart = (
  toolName: string,
  args: unknown,
  parentToolCallId?: string,
): AgentSessionEvent => ({
  args,
  toolCallId: `${toolName}-call`,
  toolName,
  type: "tool_execution_start",
  ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
});

const toolEnd = (toolName: string, parentToolCallId?: string): AgentSessionEvent => ({
  ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
  isError: false,
  result: { content: [] },
  toolCallId: `${toolName}-call`,
  toolName,
  type: "tool_execution_end",
});

/** Activity after a run that starts and then sees `events`; undefined once it ends. */
const fold = (events: readonly AgentSessionEvent[]): Activity | undefined => {
  const track = [START, ...events].reduce(nextTrack, undefined);

  return track === undefined ? undefined : trackActivity(track);
};

describe(callTarget, () => {
  it("prefers the argument that names what the call acts on", () => {
    expect(callTarget({ limit: 5, offset: 1, path: "src/a.ts" })).toBe("src/a.ts");
    expect(callTarget({ command: "vp test", timeout: 30 })).toBe("vp test");
    expect(callTarget({ flags: "-i", other: "first string" })).toBe("-i");
    expect(callTarget({ path: "  ", count: 3 })).toBeUndefined();
    expect(callTarget("not an object")).toBeUndefined();
  });
});

describe(nextTrack, () => {
  it("follows a run from start through tool calls to its end", () => {
    expect(fold([])).toStrictEqual({ kind: "phase", label: "starting" });
    expect(fold([toolStart("read", { path: "a.ts" })])).toStrictEqual({
      kind: "tool",
      label: "read",
      target: "a.ts",
    });
    expect(fold([toolStart("read", { path: "a.ts" }), toolEnd("read")])).toStrictEqual({
      kind: "phase",
      label: "waiting",
    });
    expect(
      fold([
        toolStart("read", { path: "a.ts" }),
        toolEnd("read"),
        { reason: "threshold", type: "compaction_start" },
      ]),
    ).toStrictEqual({ kind: "phase", label: "compacting" });
    expect(
      fold([toolStart("read", {}), { messages: [], type: "agent_end", willRetry: false }]),
    ).toBeUndefined();
  });

  it("shows compaction and retries Pi runs between a turn's runs", () => {
    const compacting = { kind: "phase", label: "compacting" };
    const retrying = { kind: "phase", label: "retrying" };
    const end: AgentSessionEvent = { messages: [], type: "agent_end", willRetry: false };
    const compactionStart: AgentSessionEvent = { reason: "threshold", type: "compaction_start" };

    const activity = (events: readonly AgentSessionEvent[]) => {
      const track = events.reduce(nextTrack, undefined);

      return track === undefined ? undefined : trackActivity(track);
    };

    expect(activity([compactionStart])).toStrictEqual(compacting);
    expect(activity([START, { ...end, willRetry: true }])).toStrictEqual(retrying);
    expect(
      activity([
        START,
        { ...end, willRetry: true },
        {
          attempt: 1,
          delayMs: 2000,
          errorMessage: "overloaded",
          maxAttempts: 3,
          type: "auto_retry_start",
        },
      ]),
    ).toStrictEqual(retrying);
    expect(activity([START, end, compactionStart])).toStrictEqual(compacting);
  });

  it("keeps showing a parallel call that is still executing when another finishes", () => {
    expect(
      fold([
        toolStart("bash", { command: "sleep 9" }),
        toolStart("read", { path: "a.ts" }),
        toolEnd("read"),
      ]),
    ).toStrictEqual({ kind: "tool", label: "bash", target: "sleep 9" });
    expect(
      fold([
        toolStart("bash", { command: "sleep 9" }),
        toolStart("read", { path: "a.ts" }),
        toolEnd("bash"),
      ]),
    ).toStrictEqual({ kind: "tool", label: "read", target: "a.ts" });
  });

  it("keeps a Code Mode script as the activity while its nested calls run", () => {
    const script = toolStart("code", { code: "await read()" });

    expect(fold([script, toolStart("read", { path: "a.ts" }, "code-call")])).toStrictEqual(
      fold([script]),
    );
    expect(fold([script, toolEnd("read", "code-call")])).toStrictEqual(fold([script]));
  });
});

describe(Monitor, () => {
  it("routes events to followers of that agent only, and leaves change announcements to the tree", () => {
    const monitor = new Monitor((cause) => {
      throw cause;
    });

    const changed = vi.fn();
    const followA = vi.fn();
    const followB = vi.fn();
    monitor.onChange(changed);
    monitor.follow("/root/a", followA);
    const stop = monitor.follow("/root/b", followB);

    monitor.record("/root/a", START);
    monitor.record("/root/a", toolStart("read", { path: "a.ts" }));
    expect(followA).toHaveBeenCalledTimes(2);
    expect(followB).not.toHaveBeenCalled();
    expect(monitor.activity("/root/a")).toStrictEqual({
      kind: "tool",
      label: "read",
      target: "a.ts",
    });

    stop();
    monitor.record("/root/b", START);
    expect(followB).not.toHaveBeenCalled();

    monitor.clear("/root/a");
    expect(monitor.activity("/root/a")).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
    monitor.changed();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("keeps tracking and other followers going past a failing follower, which it drops", () => {
    const monitor = new Monitor((cause) => {
      throw cause;
    });

    const failure = new Error("viewer broke");

    const broken = vi.fn(() => {
      throw failure;
    });

    const healthy = vi.fn();
    monitor.follow("/root/a", broken);
    monitor.follow("/root/a", healthy);

    expect(() => monitor.record("/root/a", START)).toThrow(failure);
    expect(monitor.activity("/root/a")).toStrictEqual({ kind: "phase", label: "starting" });
    expect(healthy).toHaveBeenCalledOnce();

    monitor.record("/root/a", toolStart("read", { path: "a.ts" }));
    expect(broken).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  it("reports a failing change listener without failing the change or the other listeners", () => {
    const errors: unknown[] = [];
    const monitor = new Monitor((cause) => errors.push(cause));
    const failure = new Error("widget broke");
    const healthy = vi.fn();
    monitor.onChange(() => {
      throw failure;
    });
    monitor.onChange(healthy);

    expect(() => monitor.changed()).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
    expect(errors).toStrictEqual([failure]);
  });
});
