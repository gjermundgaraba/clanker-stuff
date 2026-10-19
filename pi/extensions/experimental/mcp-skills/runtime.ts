import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, sep } from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { SkillApprovals } from "./approvals.js";
import { buildCatalog } from "./catalog.js";
import type { CatalogSkill } from "./catalog.js";
import { loadServers } from "./config.js";
import type { SkillFile } from "./entry.js";
import { filePath, mountRoot } from "./mount.js";
import { SkillServers, describeError } from "./servers.js";
import { checkBytes, frontmatterMatches, verifyFile } from "./verify.js";

export type Loaded = { bytes: Buffer } | { error: string };

const SERVER_NAME = /^[A-Za-z0-9_-]+$/u;

/** Text of the messages loaded skills leave their folder path in: user messages and `read` results. */
const messageText = (entry: SessionEntry): string => {
  if (entry.type !== "message") return "";

  const { message } = entry;

  const content =
    message.role === "user" ||
    (message.role === "toolResult" && message.toolName === "read" && !message.isError)
      ? message.content
      : [];

  return typeof content === "string"
    ? content
    : content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
};

/**
 * MCP skills for one session: the connections, the catalog the model and user see, and the one
 * loading path every route goes through: approval, then every file fetched, checked, and stored.
 */
export class McpSkills {
  readonly servers = new SkillServers();
  readonly approvals: SkillApprovals;
  readonly mountRoot: string;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly options: { agentDir: string; dataDir: string },
  ) {
    this.mountRoot = mountRoot(options.agentDir);
    this.approvals = new SkillApprovals(options.dataDir);
  }

  /** Read the configured servers again and connect them in the background if they changed. */
  async refresh(ctx: ExtensionContext): Promise<void> {
    const registry = ctx.modelRegistry;

    const servers = loadServers({
      agentDir: this.options.agentDir,
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
      registered: this.pi.getMcpServers(),
    });

    await this.servers.apply(servers, {
      agentDir: this.options.agentDir,
      cwd: ctx.cwd,
      providerToken: async (provider) => await registry.getApiKeyForProvider(provider),
    });
  }

  /**
   * Before a run: pick up config changes, give servers that are connecting a moment to list their
   * skills, then try failed servers again in the background for the next run.
   */
  async prepareRun(ctx: ExtensionContext, timeoutMs: number): Promise<void> {
    await this.refresh(ctx);
    await this.servers.settled(timeoutMs);
    this.servers.retryFailed();
  }

  /** Forget every approval and delete every stored skill. */
  async forget(): Promise<void> {
    await this.approvals.clear();
    await rm(this.mountRoot, { force: true, recursive: true });
  }

  /** Every loadable MCP skill, named so that none shares a name with a local skill or another one. */
  catalog(): CatalogSkill[] {
    const local = new Set(
      this.pi
        .getCommands()
        .filter((command) => command.source === "skill")
        .map((command) => command.name.slice("skill:".length)),
    );

    return buildCatalog(this.mountRoot, this.servers.statuses(), local);
  }

  /**
   * Servers whose skills are in use: a loaded skill leaves its folder path in the user message or
   * `read` result that brought it into context, so this holds for as long as that stays on the
   * branch, also after a resume.
   */
  serversInUse(ctx: ExtensionContext): Set<string> {
    const servers = new Set<string>();

    for (const entry of ctx.sessionManager.getBranch()) {
      for (const part of messageText(entry).split(`${this.mountRoot}${sep}`).slice(1)) {
        const server = part.split(sep)[0] ?? "";

        if (SERVER_NAME.test(server)) servers.add(server);
      }
    }

    return servers;
  }

  /**
   * Load a skill: ask for approval unless this version is approved, then make its folder hold its
   * checked files and return its `SKILL.md`. Nothing unchecked is stored or returned.
   */
  async load(ctx: ExtensionContext, skill: CatalogSkill, signal?: AbortSignal): Promise<Loaded> {
    const origin = this.servers.origin(skill.server);

    if (origin === undefined) return { error: `MCP server "${skill.server}" is not connected.` };

    const others = [...this.serversInUse(ctx)].filter((server) => server !== skill.server);

    if (!(await this.approvals.allow(ctx, origin, skill, others))) {
      return {
        error: ctx.hasUI
          ? `Loading MCP skill ${skill.name} was not approved.`
          : `MCP skill ${skill.name} needs approval, which needs an interactive session.`,
      };
    }

    try {
      const failure = await this.store(skill, signal);

      if (failure !== undefined) return { error: await this.refreshSkill(skill, failure, signal) };

      return { bytes: await readFile(skill.path) };
    } catch (error) {
      return { error: `Could not load MCP skill ${skill.name}: ${describeError(error)}` };
    }
  }

  /** Whether the skill's folder holds every file it lists, unchanged. */
  private async storedCopyMatches(skill: CatalogSkill): Promise<boolean> {
    const { dir, entry } = skill;

    const copies = await Promise.all(
      entry.files.map(async (file) => {
        const bytes = await readFile(filePath(dir, entry, file.uri)).catch(() => undefined);

        return bytes !== undefined && checkBytes(bytes, file) === undefined ? bytes : undefined;
      }),
    );

    const skillFile = copies[entry.files.findIndex((file) => file.uri === entry.uri)];

    return copies.every(Boolean) && skillFile !== undefined && frontmatterMatches(skillFile, entry);
  }

  /**
   * Make the skill's folder hold its files. A complete, unchanged copy is kept; otherwise every file
   * is fetched and checked, written to a new folder, and moved into place in one rename. Returns why
   * the server's content failed its checks; throws when it could not be fetched or stored.
   */
  private async store(skill: CatalogSkill, signal?: AbortSignal): Promise<string | undefined> {
    const { dir, entry, server } = skill;

    return await withFileMutationQueue(dir, async () => {
      if (await this.storedCopyMatches(skill)) return undefined;

      const results = await Promise.all(
        entry.files.map(async (file) => {
          try {
            return {
              file,
              verified: verifyFile(await this.servers.readResource(server, file.uri, signal), file),
            };
          } catch (error) {
            throw new Error(`could not fetch ${file.uri}: ${describeError(error)}`, {
              cause: error,
            });
          }
        }),
      );

      const fetched: { file: SkillFile; bytes: Buffer }[] = [];

      for (const { file, verified } of results) {
        if ("failure" in verified) return verified.failure;
        fetched.push({ bytes: verified.bytes, file });
      }

      const skillFile = fetched.find((result) => result.file.uri === entry.uri);

      if (!skillFile || !frontmatterMatches(skillFile.bytes, entry)) {
        return "its SKILL.md frontmatter differs from its listing";
      }

      const partial = `${dir}.partial-${randomUUID()}`;

      try {
        for (const { bytes, file } of fetched) {
          const path = filePath(partial, entry, file.uri);

          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, bytes);
        }

        await rm(dir, { force: true, recursive: true });
        await rename(partial, dir);
      } catch (error) {
        await rm(partial, { force: true, recursive: true });

        // Another Pi may have stored the same version meanwhile.
        if (await this.storedCopyMatches(skill)) return undefined;

        throw new Error(`could not store its files in ${dir}: ${describeError(error)}`, {
          cause: error,
        });
      }

      return undefined;
    });
  }

  /**
   * After content failed its checks, ask the server for the skill's current entry, which the
   * catalog uses from then on. A changed skill is at a new path and must be approved again.
   */
  private async refreshSkill(
    skill: CatalogSkill,
    failure: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const { entry, name, server } = skill;

    try {
      const decoded = await this.servers.getSkill(server, entry.uri, signal);

      this.servers.replaceSkill(server, entry.uri, decoded);

      if ("declined" in decoded) {
        return `MCP skill ${name} can no longer be loaded: it ${decoded.declined.reason}.`;
      }

      if (decoded.skill.revision !== entry.revision) {
        const current = this.catalog().find(
          (candidate) => candidate.server === server && candidate.entry.uri === entry.uri,
        );

        return `MCP skill ${name} changed on its server. Read ${current?.path ?? "its new SKILL.md"} to load the new version.`;
      }
    } catch (error) {
      return `MCP skill ${name} failed verification: ${failure}. Refreshing it failed: ${describeError(error)}`;
    }

    return `MCP skill ${name} failed verification: ${failure}.`;
  }
}
