import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { SkillApprovals } from "./approvals.js";
import { buildCatalog } from "./catalog.js";
import type { CatalogSkill } from "./catalog.js";
import { SERVER_NAME, loadServers } from "./config.js";
import type { SkillFile } from "./entry.js";
import { filePath, mountRoot } from "./mount.js";
import { SkillServers, describeError } from "./servers.js";
import { checkBytes, frontmatterMatches, verifyFile } from "./verify.js";

export type Loaded = { bytes: Buffer } | { error: string };

const messageText = (entry: SessionEntry): string => {
  if (entry.type !== "message") {
    return "";
  }

  const { message } = entry;

  const content =
    message.role === "user" ||
    (message.role === "toolResult" &&
      message.toolName === "read" &&
      !message.isError)
      ? message.content
      : [];

  return typeof content === "string"
    ? content
    : content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
};

const storedCopyMatches = async (skill: CatalogSkill): Promise<boolean> => {
  const { dir, entry } = skill;

  const copies = await Promise.all(
    entry.files.map(async (file) => {
      const bytes = await readFile(filePath(dir, entry, file.uri)).catch(
        (): undefined => undefined
      );

      return bytes !== undefined && checkBytes(bytes, file) === undefined
        ? bytes
        : undefined;
    })
  );

  const skillFile =
    copies[entry.files.findIndex((file) => file.uri === entry.uri)];

  return (
    copies.every(Boolean) &&
    skillFile !== undefined &&
    frontmatterMatches(skillFile, entry)
  );
};

export class McpSkills {
  readonly servers = new SkillServers();
  readonly approvals: SkillApprovals;
  readonly mountRoot: string;

  private readonly pi: ExtensionAPI;
  private readonly options: { agentDir: string; dataDir: string };

  constructor(
    pi: ExtensionAPI,
    options: { agentDir: string; dataDir: string }
  ) {
    this.pi = pi;
    this.options = options;
    this.mountRoot = mountRoot(options.agentDir);
    this.approvals = new SkillApprovals(options.dataDir);
  }

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
      providerToken: async (provider) =>
        await registry.getApiKeyForProvider(provider),
    });
  }

  async prepareRun(ctx: ExtensionContext, timeoutMs: number): Promise<void> {
    await this.refresh(ctx);
    await this.servers.settled(timeoutMs);
    this.servers.retryFailed();
  }

  async forget(): Promise<void> {
    await this.approvals.clear();
    await rm(this.mountRoot, { force: true, recursive: true });
  }

  catalog(): CatalogSkill[] {
    const local = new Set(
      this.pi
        .getCommands()
        .filter((command) => command.source === "skill")
        .map((command) => command.name.slice("skill:".length))
    );

    return buildCatalog(this.mountRoot, this.servers.statuses(), local);
  }

  serversInUse(ctx: ExtensionContext): Set<string> {
    const servers = new Set<string>();

    for (const entry of ctx.sessionManager.getBranch()) {
      for (const part of messageText(entry)
        .split(`${this.mountRoot}${path.sep}`)
        .slice(1)) {
        const server = part.split(path.sep)[0] ?? "";

        if (SERVER_NAME.test(server)) {
          servers.add(server);
        }
      }
    }

    return servers;
  }

  async load(
    ctx: ExtensionContext,
    skill: CatalogSkill,
    signal?: AbortSignal
  ): Promise<Loaded> {
    const origin = this.servers.origin(skill.server);

    if (origin === undefined) {
      return { error: `MCP server "${skill.server}" is not connected.` };
    }

    const others = [...this.serversInUse(ctx)].filter(
      (server) => server !== skill.server
    );

    if (!(await this.approvals.allow(ctx, origin, skill, others))) {
      return {
        error: ctx.hasUI
          ? `Loading MCP skill ${skill.name} was not approved.`
          : `MCP skill ${skill.name} needs approval, which needs an interactive session.`,
      };
    }

    try {
      const failure = await this.store(skill, signal);

      if (failure !== undefined) {
        return { error: await this.refreshSkill(skill, failure, signal) };
      }

      return { bytes: await readFile(skill.path) };
    } catch (error) {
      return {
        error: `Could not load MCP skill ${skill.name}: ${describeError(error)}`,
      };
    }
  }

  private async store(
    skill: CatalogSkill,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const { dir, entry, server } = skill;

    return await withFileMutationQueue(
      dir,
      async (): Promise<string | undefined> => {
        if (await storedCopyMatches(skill)) {
          return undefined;
        }

        const results = await Promise.all(
          entry.files.map(async (file) => {
            try {
              return {
                file,
                verified: verifyFile(
                  await this.servers.readResource(server, file.uri, signal),
                  file
                ),
              };
            } catch (error) {
              throw new Error(
                `could not fetch ${file.uri}: ${describeError(error)}`,
                {
                  cause: error,
                }
              );
            }
          })
        );

        const fetched: Array<{ file: SkillFile; bytes: Buffer }> = [];

        for (const { file, verified } of results) {
          if ("failure" in verified) {
            return verified.failure;
          }

          fetched.push({ bytes: verified.bytes, file });
        }

        const skillFile = fetched.find(
          (result) => result.file.uri === entry.uri
        );

        if (!skillFile || !frontmatterMatches(skillFile.bytes, entry)) {
          return "its SKILL.md frontmatter differs from its listing";
        }

        const partial = `${dir}.partial-${randomUUID()}`;

        try {
          for (const { bytes, file } of fetched) {
            const target = filePath(partial, entry, file.uri);

            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, bytes);
          }

          await rm(dir, { force: true, recursive: true });
          await rename(partial, dir);
        } catch (error) {
          await rm(partial, { force: true, recursive: true });

          const storedConcurrently = await storedCopyMatches(skill);

          if (storedConcurrently) {
            return undefined;
          }

          throw new Error(
            `could not store its files in ${dir}: ${describeError(error)}`,
            {
              cause: error,
            }
          );
        }

        return undefined;
      }
    );
  }

  private async refreshSkill(
    skill: CatalogSkill,
    failure: string,
    signal?: AbortSignal
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
          (candidate) =>
            candidate.server === server && candidate.entry.uri === entry.uri
        );

        return `MCP skill ${name} changed on its server. Read ${current?.path ?? "its new SKILL.md"} to load the new version.`;
      }
    } catch (error) {
      return `MCP skill ${name} failed verification: ${failure}. Refreshing it failed: ${describeError(error)}`;
    }

    return `MCP skill ${name} failed verification: ${failure}.`;
  }
}
