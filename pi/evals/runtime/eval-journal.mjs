import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/** @param {string} journalPath JSONL file the journal appends to. */
export const createJournal = (journalPath) => {
  const absolute = path.resolve(journalPath);

  /** @param {() => Promise<void>} operation */
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
    /** @param {unknown} event */
    emit: async (event) => {
      await write(async () => {
        await appendFile(absolute, `${JSON.stringify(event)}\n`);
      });
    },
  };
};
