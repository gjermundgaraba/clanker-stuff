import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type VoiceTrace = (kind: string, detail: unknown) => void;

export const createVoiceTrace = (): VoiceTrace | undefined => {
  const directory = process.env.PI_VOICE_TRACE_DIR;
  if (directory === undefined || directory.length === 0) {
    return undefined;
  }

  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(directory, 0o700);
  const file = path.join(directory, "voice.ndjson");
  writeFileSync(file, "", { flag: "a", mode: 0o600 });
  chmodSync(file, 0o600);
  let sequence = 0;

  return (kind, detail) => {
    sequence += 1;
    appendFileSync(
      file,
      `${JSON.stringify({
        detail,
        kind,
        monotonicNs: process.hrtime.bigint().toString(),
        sequence,
        timestamp: new Date().toISOString(),
      })}\n`,
      { encoding: "utf-8", mode: 0o600 }
    );
  };
};
