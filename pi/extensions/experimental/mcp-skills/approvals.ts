import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { CatalogSkill } from "./catalog.js";

const Stored = Type.Record(Type.String(), Type.String());

const ALLOW_NOW = "Allow until Pi exits";

const ALLOW_VERSION = "Always allow this version";

const DENY = "Deny";

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }

  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const excerpt = (text: string): string =>
  text.length > 240 ? `${text.slice(0, 239)}…` : text;

const SCRIPT_FILE =
  /\/scripts\/|\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd)$/iu;

export class SkillApprovals {
  private readonly path: string;
  private readonly untilExit = new Set<string>();

  constructor(dataDir: string) {
    this.path = path.join(dataDir, "approvals.json");
  }

  private async read(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf-8"));

      return Value.Check(Stored, parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private async remember(key: string, revision: string): Promise<void> {
    await withFileMutationQueue(this.path, async () => {
      const stored = { ...(await this.read()), [key]: revision };

      await mkdir(path.dirname(this.path), { recursive: true });
      await writeFile(this.path, `${JSON.stringify(stored, null, 2)}\n`);
    });
  }

  async clear(): Promise<void> {
    this.untilExit.clear();
    await withFileMutationQueue(this.path, async () => {
      await mkdir(path.dirname(this.path), { recursive: true });
      await writeFile(this.path, "{}\n");
    });
  }

  async allow(
    ctx: ExtensionContext,
    origin: string,
    skill: CatalogSkill,
    serversInUse: readonly string[]
  ): Promise<boolean> {
    const key = `${origin}\n${skill.entry.uri}`;
    const version = `${key}\n${skill.entry.revision}`;

    let approved = this.untilExit.has(version);

    if (!approved) {
      const stored = await this.read();
      approved = stored[key] === skill.entry.revision;
    }

    if (approved && serversInUse.length === 0) {
      return true;
    }

    if (!ctx.hasUI) {
      return false;
    }

    const { entry } = skill;
    const bytes = entry.files.reduce((total, file) => total + file.size, 0);

    const scripts = entry.files
      .filter((file) => SCRIPT_FILE.test(file.uri))
      .map((file) => file.uri.slice(entry.root.length + 1));

    const title = [
      `Load MCP skill ${inlineText(skill.name)}?`,
      `Served by MCP server "${skill.server}": ${inlineText(entry.uri)}`,
      excerpt(inlineText(entry.description)),
      `${String(entry.files.length)} ${entry.files.length === 1 ? "file" : "files"}, ${formatBytes(bytes)}${scripts.length > 0 ? `, including ${inlineText(scripts.slice(0, 5).join(", "))}` : ""}`,
      "Its instructions are untrusted. Allowing it also lets it have commands run on this machine.",
      ...(serversInUse.length > 0
        ? [
            `Skills from MCP server ${serversInUse.map((server) => `"${server}"`).join(", ")} are in use, and this reads from MCP server "${skill.server}".`,
          ]
        : []),
    ].join("\n");

    const choice = await ctx.ui.select(title, [ALLOW_NOW, ALLOW_VERSION, DENY]);

    if (choice === ALLOW_NOW) {
      this.untilExit.add(version);
    }

    if (choice === ALLOW_VERSION) {
      await this.remember(key, entry.revision);
    }

    return choice === ALLOW_NOW || choice === ALLOW_VERSION;
  }
}
