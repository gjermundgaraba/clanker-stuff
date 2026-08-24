import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";

import { patchEnv } from "../helpers/env.js";
import { createTempDir, linkDirectory } from "../helpers/fs.js";
import { createAgentSessionHarness } from "./agent-session.js";
import type { ExtensionUIContext, FauxModelDefinition } from "./agent-session.js";

export interface ExtensionSmokeHarnessOptions {
  extensions?: string[];
  packages?: string[];
  skillPaths?: string[];
  uiContext?: ExtensionUIContext;
  models?: FauxModelDefinition[];
  withConfiguredAuth?: boolean;
}

type ProviderMessageContent = string | { type?: string; text?: string }[] | undefined;

const ProviderPayloadWithMessagesSchema = Type.Object(
  {
    messages: Type.Optional(
      Type.Array(
        Type.Object({
          content: Type.Optional(
            Type.Union([
              Type.String(),
              Type.Array(
                Type.Object({
                  text: Type.Optional(Type.String()),
                  type: Type.Optional(Type.String()),
                }),
              ),
            ]),
          ),
          role: Type.Optional(Type.String()),
        }),
      ),
    ),
  },
  { additionalProperties: true },
);

const noopRestore = () => {
  /* noop */
};

const extractTextContent = (content: ProviderMessageContent): string => {
  if (Array.isArray(content)) {
    return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  }

  return content ?? "";
};

const lastUserTextFromPayload = (
  payload: Static<typeof ProviderPayloadWithMessagesSchema> | undefined,
): string => {
  const content = (payload?.messages ?? []).findLast((message) => message.role === "user")?.content;

  return extractTextContent(content);
};

export const createExtensionSmokeHarness = async (options: ExtensionSmokeHarnessOptions) => {
  let projectDir: string | undefined;
  let homeDir: string | undefined;
  let restoreEnv = noopRestore;
  let harness: Awaited<ReturnType<typeof createAgentSessionHarness>> | undefined;
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
        await linkDirectory(extensionPath, path.join(extensionsDir, path.basename(extensionPath)));
      }),
    );

    harness = await createAgentSessionHarness({
      cwd: projectDir,
      models: options.models,
      settings: options.packages === undefined ? undefined : { packages: options.packages },
      skillPaths: options.skillPaths,
      uiContext: options.uiContext,
      withConfiguredAuth: options.withConfiguredAuth,
    });

    return {
      ...harness,
      cleanup,
      homeDir,
      lastUserText() {
        try {
          return lastUserTextFromPayload(
            harness?.lastProviderPayload(ProviderPayloadWithMessagesSchema),
          );
        } catch {
          return "";
        }
      },
      projectDir,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
};

export type ExtensionSmokeHarness = Awaited<ReturnType<typeof createExtensionSmokeHarness>>;
