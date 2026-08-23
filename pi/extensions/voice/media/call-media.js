const disposedCalls = new WeakSet();
const disposedLegs = new WeakSet();

export const createCall = (microphone, leg) => ({
  leg,
  microphone,
  muted: false,
  renewal: undefined,
});

export const commitRenewal = (call, renewal) => {
  if (call.renewal !== renewal) {
    throw new Error("Voice renewal was cancelled.");
  }
  const previousLeg = call.leg;
  call.leg = renewal.warmLeg;
  call.renewal = undefined;
  return previousLeg;
};

export const disposeLeg = (leg) => {
  if (!leg || disposedLegs.has(leg)) {
    return false;
  }
  disposedLegs.add(leg);

  leg.session.close();
  for (const track of leg.stream.getTracks()) {
    track.stop();
  }
  leg.audio.pause();
  leg.audio.srcObject = null;
  return true;
};

export const disposeCallMedia = (call, reason) => {
  if (!call || disposedCalls.has(call)) {
    return false;
  }
  disposedCalls.add(call);

  const { renewal } = call;
  call.renewal = undefined;
  renewal?.controller.abort(reason);
  if (renewal?.warmLeg !== call.leg) {
    disposeLeg(renewal?.warmLeg);
  }
  disposeLeg(call.leg);
  call.microphone.close();
  return true;
};
