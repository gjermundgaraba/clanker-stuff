import { createHash } from "node:crypto";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ReadResourceResult } from "@earendil-works/pi-mcp";

import { canonicalJson } from "./entry.js";
import type { SkillEntry, SkillFile } from "./entry.js";

export const checkBytes = (
  bytes: Buffer,
  file: SkillFile
): string | undefined => {
  if (bytes.length !== file.size) {
    return `${file.uri} has ${String(bytes.length)} bytes, but the skill lists ${String(file.size)}`;
  }

  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

  return digest === file.digest
    ? undefined
    : `${file.uri} does not match its digest`;
};

export const verifyFile = (
  result: ReadResourceResult,
  file: SkillFile
): { bytes: Buffer } | { failure: string } => {
  const item = result.contents.find((content) => content.uri === file.uri);

  if (!item) {
    return { failure: `the server returned no content for ${file.uri}` };
  }

  const bytes =
    "blob" in item
      ? Buffer.from(item.blob, "base64")
      : Buffer.from(item.text, "utf-8");

  const failure = checkBytes(bytes, file);

  return failure === undefined ? { bytes } : { failure };
};

export const frontmatterMatches = (
  bytes: Buffer,
  entry: SkillEntry
): boolean => {
  try {
    const { frontmatter } = parseFrontmatter(bytes.toString("utf-8"));

    return canonicalJson(frontmatter) === entry.frontmatterJson;
  } catch {
    return false;
  }
};
