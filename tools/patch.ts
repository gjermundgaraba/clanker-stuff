import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { resolvePath } from "./path.js";

interface PatchLine {
  kind: " " | "+" | "-";
  text: string;
}

interface UpdateSection {
  anchor?: string;
  eof?: boolean;
  lines: PatchLine[];
}

type PatchOperation =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | {
      kind: "update";
      moveTo?: string;
      path: string;
      sections: UpdateSection[];
    };

export interface PatchChange {
  from?: string;
  kind: "add" | "delete" | "update";
  path: string;
}

export interface PatchResult {
  changes: PatchChange[];
  output: string;
}

const isOperationHeader = (line: string | undefined): boolean =>
  (line?.startsWith("*** Add File: ") ?? false) ||
  (line?.startsWith("*** Delete File: ") ?? false) ||
  (line?.startsWith("*** Update File: ") ?? false);

const getHeaderPath = (header: string, prefix: string): string => {
  const path = header.slice(prefix.length);
  if (path.length === 0) {
    throw new Error(`Patch path must not be empty: ${header}`);
  }
  return path;
};

// oxlint-disable-next-line eslint/complexity -- parses the closed Codex patch grammar
const parsePatch = (patch: string): PatchOperation[] => {
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") {
    throw new Error(
      "Patch must start with *** Begin Patch and end with *** End Patch"
    );
  }

  const operations: PatchOperation[] = [];
  let index = 0;
  while (index < lines.length) {
    const header = lines[index] ?? "";
    index += 1;

    if (header.startsWith("*** Add File: ")) {
      const path = getHeaderPath(header, "*** Add File: ");
      const content: string[] = [];
      while (index < lines.length && !isOperationHeader(lines[index])) {
        const line = lines[index] ?? "";
        if (!line.startsWith("+")) {
          throw new Error(`Invalid add-file line: ${line}`);
        }
        content.push(line.slice(1));
        index += 1;
      }
      if (content.length === 0) {
        throw new Error(`Add-file patch has no content: ${path}`);
      }
      operations.push({ kind: "add", lines: content, path });
      continue;
    }

    if (header.startsWith("*** Delete File: ")) {
      operations.push({
        kind: "delete",
        path: getHeaderPath(header, "*** Delete File: "),
      });
      continue;
    }

    if (header.startsWith("*** Update File: ")) {
      const path = getHeaderPath(header, "*** Update File: ");
      let moveTo: string | undefined;
      if (lines[index]?.startsWith("*** Move to: ")) {
        moveTo = getHeaderPath(lines[index] ?? "", "*** Move to: ");
        index += 1;
      }

      const sections: UpdateSection[] = [];
      let section: UpdateSection | undefined;
      let reachedEndOfFile = false;
      while (index < lines.length && !isOperationHeader(lines[index])) {
        const line = lines[index] ?? "";
        index += 1;
        if (reachedEndOfFile) {
          throw new Error(`End-of-file marker must end the update: ${path}`);
        }
        if (line === "*** End of File") {
          if (!section) {
            throw new Error(`End-of-file marker has no patch hunk: ${path}`);
          }
          section.eof = true;
          reachedEndOfFile = true;
          continue;
        }
        if (line === "@@" || line.startsWith("@@ ")) {
          section = {
            anchor: line === "@@" ? undefined : line.slice(3),
            lines: [],
          };
          sections.push(section);
          continue;
        }
        const [kind] = line;
        if (kind !== " " && kind !== "+" && kind !== "-") {
          throw new Error(`Invalid update line: ${line}`);
        }
        section ??= { lines: [] };
        if (!sections.includes(section)) {
          sections.push(section);
        }
        section.lines.push({ kind, text: line.slice(1) });
      }
      if (sections.length === 0 && moveTo === undefined) {
        throw new Error(`Update-file patch has no changes: ${path}`);
      }
      operations.push({ kind: "update", moveTo, path, sections });
      continue;
    }

    throw new Error(`Invalid patch header: ${header}`);
  }

  if (operations.length === 0) {
    throw new Error("Patch must contain at least one file operation");
  }
  return operations;
};

const findSequence = (
  source: string[],
  expected: string[],
  start: number,
  eof = false
): number => {
  if (expected.length === 0) {
    return eof ? source.length : start;
  }
  const matchesAt = (offset: number, trim: boolean) =>
    expected.every((line, index) => {
      const actual = source[offset + index];
      return trim ? actual?.trim() === line.trim() : actual === line;
    });

  const firstOffset = eof ? source.length - expected.length : start;
  const lastOffset = source.length - expected.length;
  if (firstOffset < start) {
    return -1;
  }
  for (let offset = firstOffset; offset <= lastOffset; offset += 1) {
    if (matchesAt(offset, false)) {
      return offset;
    }
    if (eof) {
      break;
    }
  }
  for (let offset = firstOffset; offset <= lastOffset; offset += 1) {
    if (matchesAt(offset, true)) {
      return offset;
    }
    if (eof) {
      break;
    }
  }
  return -1;
};

const findAnchor = (source: string[], anchor: string, start: number) =>
  source.findIndex((line, index) => index >= start && line.includes(anchor));

const applySections = (
  content: string,
  sections: UpdateSection[],
  filePath: string
) => {
  const finalNewline = content.endsWith("\n");
  let source =
    content.length === 0 ? [] : content.replace(/\n$/u, "").split("\n");
  let cursor = 0;

  for (const section of sections) {
    if (section.anchor !== undefined) {
      const anchorIndex = findAnchor(source, section.anchor, cursor);
      if (anchorIndex === -1) {
        throw new Error(
          `Could not find patch context "${section.anchor}" in ${filePath}`
        );
      }
      cursor = anchorIndex + 1;
    }

    const oldLines = section.lines
      .filter((line) => line.kind !== "+")
      .map((line) => line.text);
    const newLines = section.lines
      .filter((line) => line.kind !== "-")
      .map((line) => line.text);
    const offset = findSequence(source, oldLines, cursor, section.eof);
    if (offset === -1) {
      throw new Error(`Could not find patch hunk in ${filePath}`);
    }
    source = [
      ...source.slice(0, offset),
      ...newLines,
      ...source.slice(offset + oldLines.length),
    ];
    cursor = offset + newLines.length;
  }

  return `${source.join("\n")}${finalNewline && source.length > 0 ? "\n" : ""}`;
};

const withQueues = async <T>(paths: string[], operation: () => Promise<T>) => {
  const uniquePaths = [...new Set(paths)].toSorted();
  const enter = async (index: number): Promise<T> => {
    const path = uniquePaths[index];
    if (path === undefined) {
      return await operation();
    }
    return await withFileMutationQueue(
      path,
      async () => await enter(index + 1)
    );
  };
  return await enter(0);
};

export const applyPatch = async (
  patch: string,
  cwd: string,
  signal?: AbortSignal
): Promise<PatchResult> => {
  const mutation = { started: false };
  const throwIfAborted = () => {
    if (!mutation.started && signal?.aborted) {
      throw new Error("Operation aborted");
    }
  };
  throwIfAborted();
  const operations = parsePatch(patch);
  const changes: PatchChange[] = [];

  for (const operation of operations) {
    throwIfAborted();
    const sourcePath = resolvePath(operation.path, cwd);
    if (operation.kind === "add") {
      // oxlint-disable-next-line eslint/no-await-in-loop -- patch operations are ordered
      await withFileMutationQueue(sourcePath, async () => {
        throwIfAborted();
        await mkdir(nodePath.dirname(sourcePath), { recursive: true });
        throwIfAborted();
        mutation.started = true;
        await writeFile(sourcePath, `${operation.lines.join("\n")}\n`, {
          encoding: "utf-8",
          flag: "wx",
        });
      });
      changes.push({ kind: "add", path: operation.path });
      continue;
    }

    if (operation.kind === "delete") {
      // oxlint-disable-next-line eslint/no-await-in-loop -- patch operations are ordered
      await withFileMutationQueue(sourcePath, async () => {
        throwIfAborted();
        mutation.started = true;
        await rm(sourcePath);
      });
      changes.push({ kind: "delete", path: operation.path });
      continue;
    }

    const destinationPath =
      operation.moveTo === undefined
        ? sourcePath
        : resolvePath(operation.moveTo, cwd);
    // oxlint-disable-next-line eslint/no-await-in-loop -- patch operations are ordered
    await withQueues([sourcePath, destinationPath], async () => {
      throwIfAborted();
      let updated: string | undefined;
      if (operation.sections.length > 0) {
        const content = await readFile(sourcePath, "utf-8");
        throwIfAborted();
        updated = applySections(content, operation.sections, operation.path);
      }
      if (destinationPath !== sourcePath) {
        await mkdir(nodePath.dirname(destinationPath), { recursive: true });
        throwIfAborted();
      }
      mutation.started = true;
      if (updated !== undefined) {
        await writeFile(sourcePath, updated, "utf-8");
      }
      if (destinationPath !== sourcePath) {
        await rename(sourcePath, destinationPath);
      }
    });
    changes.push({
      ...(operation.moveTo ? { from: operation.path } : {}),
      kind: "update",
      path: operation.moveTo ?? operation.path,
    });
  }

  return {
    changes,
    output: `Done!\n${changes.map((change) => `- ${change.path}`).join("\n")}`,
  };
};
