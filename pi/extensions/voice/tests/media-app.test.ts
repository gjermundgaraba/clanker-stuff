import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  commitRenewal,
  createCall,
  disposeCallMedia,
  disposeLeg,
} from "../media/call-media.js";
import type { CallMediaLeg } from "../media/call-media.js";

const createLeg = () => {
  const close = vi.fn<() => void>();
  const pause = vi.fn<() => void>();
  const stop = vi.fn<() => void>();
  const leg: CallMediaLeg = {
    audio: { pause, srcObject: {} },
    session: { close },
    stream: { getTracks: () => [{ stop }] },
  };
  return { close, leg, pause, stop };
};

describe("voice media app", () => {
  it("atomically transfers the warm leg to its call", () => {
    const previous = createLeg();
    const warm = createLeg();
    const call = createCall({ close: vi.fn<() => void>() }, previous.leg);
    call.muted = true;
    const renewal = {
      controller: new AbortController(),
      warmLeg: warm.leg,
    };
    call.renewal = renewal;

    expect(commitRenewal(call, renewal)).toBe(previous.leg);
    expect(call).toMatchObject({
      leg: warm.leg,
      muted: true,
      renewal: undefined,
    });
    expect(previous.close).not.toHaveBeenCalled();
    expect(warm.close).not.toHaveBeenCalled();
  });

  it("disposes active and warming legs exactly once with their call", () => {
    const active = createLeg();
    const warm = createLeg();
    const microphone = { close: vi.fn<() => void>() };
    const call = createCall(microphone, active.leg);
    const controller = new AbortController();
    const abort = vi.spyOn(controller, "abort");
    call.renewal = { controller, warmLeg: warm.leg };
    const reason = new Error("closed");

    expect([
      disposeCallMedia(call, reason),
      disposeCallMedia(call, reason),
      disposeLeg(active.leg),
      disposeLeg(warm.leg),
    ]).toStrictEqual([true, false, false, false]);

    expect(abort).toHaveBeenCalledExactlyOnceWith(reason);
    expect(microphone.close).toHaveBeenCalledOnce();
    expect([
      active.close.mock.calls.length,
      active.stop.mock.calls.length,
      active.pause.mock.calls.length,
      warm.close.mock.calls.length,
      warm.stop.mock.calls.length,
      warm.pause.mock.calls.length,
    ]).toStrictEqual([1, 1, 1, 1, 1, 1]);
    expect([
      active.leg.audio.srcObject,
      warm.leg.audio.srcObject,
    ]).toStrictEqual([null, null]);
  });

  it("guards renewal requests and the final media swap with call identity", async () => {
    const source = await readFile(
      new URL("../media/app.js", import.meta.url),
      "utf-8"
    );

    expect(source).toMatch(
      /const originCall = currentCall;[\s\S]*currentCall === originCall[\s\S]*request\("renew_offer", offer, controller\.signal\)[\s\S]*request\("renew_commit", undefined, controller\.signal\)[\s\S]*requireCurrent\(\);[\s\S]*commitRenewal\(originCall, renewal\)/u
    );
    expect(source).toContain(
      'disposeCallMedia(closingCall, new Error("Voice call closed."));'
    );
  });
});
