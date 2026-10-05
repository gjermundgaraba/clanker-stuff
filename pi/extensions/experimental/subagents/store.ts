import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import { emptyTree, TreeSchema } from "./protocol.js";
import type { Tree } from "./protocol.js";

/** Version 3 trees live in their own directory, so earlier formats are never read. */
const TREE_DIRECTORY = "trees-v3";

const writeAtomically = async (file: string, contents: string): Promise<void> => {
  await mkdir(path.dirname(file), { mode: 0o700, recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

/** Writes whole trees in call order; nothing touches disk before the first mutation. */
export class TreeStore {
  readonly #file: string | undefined;

  constructor(file: string | undefined) {
    this.#file = file;
  }

  async save(tree: Tree): Promise<void> {
    const file = this.#file;

    if (file === undefined) {
      return;
    }

    const contents = `${JSON.stringify(tree)}\n`;
    await withFileMutationQueue(file, () => writeAtomically(file, contents));
  }
}

export interface OpenedTree {
  store: TreeStore;
  tree: Tree;
  warning: string | undefined;
}

const fresh = (store: TreeStore, warning?: string): OpenedTree => ({
  store,
  tree: emptyTree(),
  warning,
});

/** Opens the tree for a root session; an unreadable tree is reported and replaced by a fresh one. */
export const openTree = async (
  dataDir: string,
  sessionId: string,
  persistent: boolean,
): Promise<OpenedTree> => {
  if (!persistent) {
    return fresh(new TreeStore(undefined));
  }

  const key = createHash("sha256").update(sessionId).digest("hex");
  const file = path.join(dataDir, TREE_DIRECTORY, `${key}.json`);
  const store = new TreeStore(file);
  let text: string;

  try {
    text = await readFile(file, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return fresh(store);
    }

    return fresh(
      store,
      `Starting a new subagent tree; ${file} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const parsed: unknown = JSON.parse(text);

    if (Value.Check(TreeSchema, parsed)) {
      return { store, tree: parsed, warning: undefined };
    }
  } catch {
    // Malformed JSON is reported below with schema mismatches.
  }

  return fresh(store, `Starting a new subagent tree; ${file} is not a valid version 3 tree.`);
};
