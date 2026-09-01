import { describe, expect, it, vi } from "vite-plus/test";

import {
  delegationContextEvents,
  parseTranscriptEvent,
  rememberDelegationId,
  sessionConfig,
  VoiceSession,
  type VoiceSessionControl,
  type VoiceDelegation,
  VOICE_INSTRUCTIONS,
} from "../realtime.js";

interface FakeSessionControl extends VoiceSessionControl {
  appendHandoffMessage: ReturnType<
    typeof vi.fn<
      (delegationId: string, channel: "commentary" | "speakable", text: string) => boolean
    >
  >;
  close: ReturnType<typeof vi.fn<() => void>>;
  mediaReady: ReturnType<typeof vi.fn<() => void>>;
  onDelegation: (event: Omit<VoiceDelegation, "transcriptDelta">) => void;
}

const fakeSessionControl = (callId: string): FakeSessionControl => ({
  appendHandoffMessage: vi.fn(() => true),
  callId,
  close: vi.fn(),
  createCall: vi.fn(async () => "v=0"),
  mediaReady: vi.fn(),
  onDelegation: () => {},
});

describe("realtime session protocol", () => {
  it("uses the observed Codex model, voice, and handoff policy", () => {
    expect(sessionConfig([])).toMatchObject({
      audio: { output: { voice: "maple" } },
      delegation: { type: "client" },
      instructions: VOICE_INSTRUCTIONS,
      model: "gpt-live-1-codex",
    });
    expect(VOICE_INSTRUCTIONS).toContain("POST_SPAWN_SILENCE");
    expect(VOICE_INSTRUCTIONS).toContain("Session-context ambiguity");
    expect(VOICE_INSTRUCTIONS).toContain("[STATUS]");
    expect(VOICE_INSTRUCTIONS).toContain("[COMPLETE]");
  });

  it("keeps repeated requests in their unresolved handoff", () => {
    expect(VOICE_INSTRUCTIONS).toContain("do not call `SpawnThinking` again");
  });

  it("builds only delegation-bound status and completion frames", () => {
    expect(delegationContextEvents("handoff-1", "commentary", "Found it.")).toStrictEqual([
      {
        channel: "commentary",
        content: [{ text: "[STATUS] Found it.", type: "input_text" }],
        delegation_item_id: "handoff-1",
        type: "delegation.context.append",
      },
    ]);
    expect(delegationContextEvents("handoff-1", "speakable", "Done.")).toStrictEqual([
      {
        channel: "speakable",
        content: [{ text: "[COMPLETE] Done.", type: "input_text" }],
        delegation_item_id: "handoff-1",
        type: "delegation.context.append",
      },
    ]);
  });

  it("accepts each delegation ID once and bounds replay memory", () => {
    const seen = new Set<string>();

    expect(rememberDelegationId(seen, "handoff-0")).toBeTruthy();
    expect(rememberDelegationId(seen, "handoff-0")).toBeFalsy();
    for (let index = 1; index <= 1000; index += 1) {
      expect(rememberDelegationId(seen, `handoff-${index}`)).toBeTruthy();
    }

    expect(seen.size).toBe(1000);
    expect(rememberDelegationId(seen, "handoff-0")).toBeTruthy();
  });
});

describe("realtime transcript protocol", () => {
  it("parses frameless transcript deltas", () => {
    expect(
      parseTranscriptEvent({
        item: { id: "a1", text: "Working " },
        type: "output_transcript.added",
      }),
    ).toStrictEqual({
      delta: true,
      role: "assistant",
      text: "Working ",
    });
    expect(
      parseTranscriptEvent({
        item: { id: "u1", text: "Can you" },
        type: "input_transcript.added",
      }),
    ).toStrictEqual({
      delta: true,
      role: "user",
      text: "Can you",
    });
  });

  it("parses completed turns", () => {
    expect(
      parseTranscriptEvent({
        turn: { id: "u1", role: "user", transcript: "Fix it" },
        type: "turn.done",
      }),
    ).toStrictEqual({
      delta: false,
      role: "user",
      text: "Fix it",
    });
  });

  it("ignores unrelated events", () => {
    expect(parseTranscriptEvent({ type: "response.created" })).toBeUndefined();
  });
});

describe("realtime connection cancellation", () => {
  it("does not report a stopped connection attempt as failed", async () => {
    const auth = Promise.withResolvers<{
      accessToken: string;
      accountId: string;
    }>();
    const errors: string[] = [];
    const states: string[] = [];
    const voice = new VoiceSession({
      onDelegation: () => {},
      onError: (message) => {
        errors.push(message);
      },
      onRenewDue: () => {},
      onState: (state) => {
        states.push(state);
      },
      resolveAuth: () => auth.promise,
      threadId: "thread-1",
    });

    const connection = voice.acceptOffer("v=0");
    voice.dispose();
    auth.resolve({ accessToken: "token", accountId: "account-1" });

    await expect(connection).rejects.toThrow("cancelled");
    expect(errors).toStrictEqual([]);
    expect(states).toStrictEqual(["connecting", "closed"]);
  });

  it("does not let a replaced connection fail its replacement", async () => {
    const firstAuth = Promise.withResolvers<{
      accessToken: string;
      accountId: string;
    }>();
    const secondAuth = Promise.withResolvers<{
      accessToken: string;
      accountId: string;
    }>();
    const auth = [firstAuth, secondAuth];
    const errors: string[] = [];
    const states: string[] = [];
    const voice = new VoiceSession({
      onDelegation: () => {},
      onError: (message) => {
        errors.push(message);
      },
      onRenewDue: () => {},
      onState: (state) => {
        states.push(state);
      },
      resolveAuth: () =>
        auth.shift()?.promise ?? Promise.reject(new Error("No auth resolver available.")),
      threadId: "thread-1",
    });

    const firstConnection = voice.acceptOffer("v=0");
    const secondConnection = voice.acceptOffer("v=0");
    firstAuth.resolve({ accessToken: "token", accountId: "account-1" });
    await expect(firstConnection).rejects.toThrow("cancelled");
    voice.dispose();
    secondAuth.resolve({ accessToken: "token", accountId: "account-1" });
    await expect(secondConnection).rejects.toThrow("cancelled");

    expect({ errors, states }).toStrictEqual({
      errors: [],
      states: ["connecting", "connecting", "closed"],
    });
  });

  it("does not report a stopped renewal attempt as failed", async () => {
    const auth = Promise.withResolvers<{
      accessToken: string;
      accountId: string;
    }>();
    const errors: string[] = [];
    const active = fakeSessionControl("call-1");
    const replacement = fakeSessionControl("call-2");
    const controls = [active, replacement];
    let authAttempt = 0;
    const voice = new VoiceSession(
      {
        onDelegation: () => {},
        onError: (message) => {
          errors.push(message);
        },
        onRenewDue: () => {},
        onState: () => {},
        resolveAuth: () => {
          authAttempt += 1;
          return authAttempt === 1
            ? Promise.resolve({ accessToken: "token", accountId: "account-1" })
            : auth.promise;
        },
        threadId: "thread-1",
      },
      (options) => {
        const control = controls.shift();
        if (!control) {
          throw new Error("No fake voice control available.");
        }
        control.onDelegation = options.onDelegation;
        return control;
      },
    );
    await voice.acceptOffer("v=0");

    const renewal = voice.renewOffer("v=0");
    voice.dispose();
    auth.resolve({ accessToken: "token", accountId: "account-1" });

    await expect(renewal).rejects.toThrow("cancelled");
    expect(errors).toStrictEqual([]);
  });
});

describe("realtime renewal gating", () => {
  it("waits for handoffs and rejects a raced cutover", async () => {
    vi.useFakeTimers();
    try {
      const renewalRequests = vi.fn<() => void>();
      const active = fakeSessionControl("call-1");
      const firstWarm = fakeSessionControl("call-2");
      const secondWarm = fakeSessionControl("call-3");
      const controls = [active, firstWarm, secondWarm];
      const voice = new VoiceSession(
        {
          onDelegation: () => {},
          onError: () => {},
          onRenewDue: renewalRequests,
          onState: () => {},
          resolveAuth: async () => ({
            accessToken: "token",
            accountId: "account-1",
          }),
          threadId: "thread-1",
        },
        (options) => {
          const control = controls.shift();
          if (!control) {
            throw new Error("No fake voice control available.");
          }
          control.onDelegation = options.onDelegation;
          return control;
        },
      );
      await voice.acceptOffer("v=0");
      voice.mediaReady();
      active.onDelegation({
        binding: { callId: "call-1", delegationId: "handoff-a" },
        input: "question a",
      });

      await vi.advanceTimersByTimeAsync(55 * 60_000);
      const requestsBeforeCompletion = renewalRequests.mock.calls.length;
      voice.sendComplete({ callId: "call-1", delegationId: "handoff-a" }, "answer a");
      const requestsAfterCompletion = renewalRequests.mock.calls.length;

      await voice.renewOffer("v=0");
      active.onDelegation({
        binding: { callId: "call-1", delegationId: "handoff-b" },
        input: "question b",
      });
      const racedCommit = voice.commitRenew();
      await expect(racedCommit).rejects.toThrow("deferred");
      voice.abortRenew();
      voice.sendComplete({ callId: "call-1", delegationId: "handoff-b" }, "answer b");

      await voice.renewOffer("v=0");
      await voice.commitRenew();

      expect({
        activeCallAccepted: voice.sendStatus(
          { callId: "call-3", delegationId: "handoff-c" },
          "status c",
        ),
        firstWarmClosed: firstWarm.close.mock.calls.length,
        oldCallClosed: active.close.mock.calls.length,
        requestsAfterCompletion,
        requestsAfterRace: renewalRequests.mock.calls.length,
        requestsBeforeCompletion,
        secondWarmReady: secondWarm.mediaReady.mock.calls.length,
      }).toStrictEqual({
        activeCallAccepted: true,
        firstWarmClosed: 1,
        oldCallClosed: 1,
        requestsAfterCompletion: 1,
        requestsAfterRace: 2,
        requestsBeforeCompletion: 0,
        secondWarmReady: 1,
      });
      voice.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
