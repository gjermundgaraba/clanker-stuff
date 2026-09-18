import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

// Share Pi's per-file queue, never its JSON stdout descriptor. Await writes at
// event boundaries so completed telemetry is durable before the next request.
/** @param {string} path */
export function createJournal(path) {
  const absolute = resolve(path);

  /** @param {() => Promise<void>} operation */
  const write = (operation) =>
    withFileMutationQueue(absolute, async () => {
      await mkdir(dirname(absolute), { recursive: true });
      await operation();
    });

  return {
    reset: () => write(() => writeFile(absolute, "")),
    // The journal is the arbitrary-value serialization boundary for heterogeneous telemetry.
    /** @param {unknown} event */
    emit: (event) => write(() => appendFile(absolute, `${JSON.stringify(event)}\n`)),
  };
}
