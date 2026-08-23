export interface CallMediaAudio {
  pause: () => void;
  srcObject: unknown;
}

export interface CallMediaLeg {
  audio: CallMediaAudio;
  session: {
    close: () => void;
  };
  stream: {
    getTracks: () => { stop: () => void }[];
  };
}

export interface CallMediaMicrophone {
  close: () => void;
}

export interface CallMediaRenewal {
  controller: AbortController;
  warmLeg: CallMediaLeg;
}

export interface CallMedia {
  leg: CallMediaLeg;
  microphone: CallMediaMicrophone;
  muted: boolean;
  renewal: CallMediaRenewal | undefined;
}

export const createCall: (
  microphone: CallMediaMicrophone,
  leg: CallMediaLeg
) => CallMedia;

export const commitRenewal: (
  call: CallMedia,
  renewal: CallMediaRenewal
) => CallMediaLeg;

export const disposeLeg: (leg: CallMediaLeg | undefined) => boolean;

export const disposeCallMedia: (
  call: CallMedia | undefined,
  reason: Error
) => boolean;
