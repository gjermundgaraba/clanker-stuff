import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { patchEnv } from "../helpers/env.js";
import { createTempDir, linkDirectory } from "../helpers/fs.js";
import { createAgentSessionHarness } from "./agent-session.js";
import type {
  ExtensionUIContext,
  FauxModelDefinition,
} from "./agent-session.js";

export interface ExtensionSmokeHarnessOptions {
  extensions?: string[];
  packages?: string[];
  skillPaths?: string[];
  uiContext?: ExtensionUIContext;
  models?: FauxModelDefinition[];
  withConfiguredAuth?: boolean;
  configFiles?: Record<string, string>;
}

type ProviderMessageContent =
  | string
  | { type?: string; text?: string }[]
  | undefined;

interface ProviderPayloadWithMessages {
  messages?: {
    role?: string;
    content?: ProviderMessageContent;
  }[];
}

const noopRestore = () => {
  /* noop */
};

const extractTextContent = (content: ProviderMessageContent): string => {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
      .join("\n");
  }

  return "";
};

const lastUserTextFromPayload = (payload: unknown): string => {
  const messages = (payload as ProviderPayloadWithMessages | undefined)
    ?.messages;
  const content = [...(messages ?? [])]
    .toReversed()
    .find((message) => message.role === "user")?.content;

  return extractTextContent(content);
};

export const createExtensionSmokeHarness = async (
  options: ExtensionSmokeHarnessOptions
) => {
  let projectDir: string | undefined;
  let homeDir: string | undefined;
  let restoreEnv = noopRestore;
  let harness:
    | Awaited<ReturnType<typeof createAgentSessionHarness>>
    | undefined;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;

    try {
      harness?.cleanup();
    } finally {
      harness = undefined;

      try {
        restoreEnv();
      } finally {
        if (projectDir && existsSync(projectDir)) {
          rmSync(projectDir, { force: true, recursive: true });
        }
        if (homeDir && existsSync(homeDir)) {
          rmSync(homeDir, { force: true, recursive: true });
        }
      }
    }
  };

  try {
    projectDir = await createTempDir("extension-smoke-project-");
    homeDir = await createTempDir("extension-smoke-home-");
    restoreEnv = patchEnv({ HOME: homeDir });

    const extensionsDir = path.join(projectDir, ".pi", "extensions");
    mkdirSync(extensionsDir, { recursive: true });

    await Promise.all(
      (options.extensions ?? []).map(async (extensionPath) => {
        await linkDirectory(
          extensionPath,
          path.join(extensionsDir, path.basename(extensionPath))
        );
      })
    );

    if (options.configFiles) {
      const configDir = path.join(homeDir, ".pi", "agent", "extensions");
      mkdirSync(configDir, { recursive: true });
      for (const [fileName, content] of Object.entries(options.configFiles)) {
        writeFileSync(path.join(configDir, fileName), content, "utf-8");
      }
    }

    harness = await createAgentSessionHarness({
      cwd: projectDir,
      models: options.models,
      settings:
        options.packages === undefined
          ? undefined
          : { packages: options.packages },
      skillPaths: options.skillPaths,
      uiContext: options.uiContext,
      withConfiguredAuth: options.withConfiguredAuth,
    });

    return {
      ...harness,
      cleanup,
      homeDir,
      lastUserText() {
        return lastUserTextFromPayload(harness?.lastProviderPayload());
      },
      projectDir,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
};

export type ExtensionSmokeHarness = Awaited<
  ReturnType<typeof createExtensionSmokeHarness>
>;
