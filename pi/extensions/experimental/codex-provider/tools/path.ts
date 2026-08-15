import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;

export const resolvePath = (input: string, cwd: string): string => {
  let normalized = input.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  if (normalized === "~") {
    return homedir();
  }
  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    normalized = path.join(homedir(), normalized.slice(2));
  } else if (normalized.startsWith("file://")) {
    normalized = fileURLToPath(normalized);
  }
  return path.resolve(cwd, normalized);
};
