import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

// Share Pi's per-file queue, never its JSON stdout descriptor. Await writes at
// event boundaries so completed telemetry is durable before the next request.
/** @param {string} journalPath JSONL file the journal appends to. */
export const createJournal = (journalPath) => {
  const absolute = path.resolve(journalPath);

  /** @param {() => Promise<void>} operation Write to run inside the file's mutation queue. */
  const write = async (operation) => {
    await withFileMutationQueue(absolute, async () => {
      await mkdir(path.dirname(absolute), { recursive: true });
      await operation();
    });
  };

  return {
    reset: async () => {
      await write(async () => {
        await writeFile(absolute, "");
      });
    },
    // The journal is the arbitrary-value serialization boundary for heterogeneous telemetry.
    /** @param {unknown} event Telemetry event to append as one JSON line. */
    emit: async (event) => {
      await write(async () => {
        await appendFile(absolute, `${JSON.stringify(event)}\n`);
      });
    },
  };
};
