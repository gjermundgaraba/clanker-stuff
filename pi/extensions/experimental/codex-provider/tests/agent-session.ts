import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { Api, Model, Transport } from "@earendil-works/pi-ai";
import type {
  CompactionSettings,
  ExtensionError,
  ExtensionFactory,
  ExtensionContext,
  ExtensionUIContext,
  RetrySettings,
  SessionManager,
  Skill,
} from "@earendil-works/pi-coding-agent";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";

import { SPIKE_API_KEY, SPIKE_MODEL } from "./fixtures.js";

interface RealCodexSessionOptions {
  apiKey?: string;
  tools?: string[];
  excludeTools?: string[];
  compaction?: CompactionSettings;
  extensionFactories: ExtensionFactory[];
  model?: Model<Api>;
  additionalModels?: readonly Model<Api>[];
  mode?: ExtensionContext["mode"];
  retry?: RetrySettings;
  rootDir: string;
  sessionManager: SessionManager;
  skills?: Skill[];
  transport?: Transport;
  onExtensionError?: (error: ExtensionError) => void;
  uiContext?: ExtensionUIContext;
  systemPrompt?: string;
}

/** Creates a real AgentSession through public Pi APIs. */
export const createRealCodexSession = async (options: RealCodexSessionOptions) => {
  const agentDir = path.join(
    options.rootDir,
    `agent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  await mkdir(agentDir, { recursive: true });

  const apiKey = options.apiKey ?? SPIKE_API_KEY;
  const model: Model<Api> = options.model ?? SPIKE_MODEL;
  const modelsPath = path.join(agentDir, "models.json");
  // Exercise Pi's persistent user-override layer. Temporary provider registration
  // is replaced when the extension installs its authoritative catalog.
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        [model.provider]: {
          api: model.api,
          apiKey,
          baseUrl: model.baseUrl,
          modelOverrides: Object.fromEntries(
            [model, ...(options.additionalModels ?? [])].map(
              ({ id, api: _api, provider: _provider, baseUrl: _baseUrl, ...override }) => [
                id,
                override,
              ],
            ),
          ),
          models: (options.additionalModels ?? []).filter(
            (candidate) => candidate.baseUrl !== model.baseUrl,
          ),
        },
      },
    }),
  );

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath,
    // Keep background catalog writes off disk while exercising real models.json overrides.
    modelsStore: new InMemoryModelsStore(),
  });

  modelRuntime.registerProvider(model.provider, {
    api: model.api,
    apiKey,
    baseUrl: model.baseUrl,
    models: [model, ...(options.additionalModels ?? [])],
  });

  if (apiKey) {
    await modelRuntime.setRuntimeApiKey(model.provider, apiKey);
  }

  const settingsManager = SettingsManager.inMemory({
    ...(options.compaction !== undefined ? { compaction: options.compaction } : {}),
    ...(options.retry !== undefined ? { retry: options.retry } : {}),
    transport: options.transport ?? "sse",
  });

  const resourceLoader = new DefaultResourceLoader({
    agentDir,
    cwd: options.sessionManager.getCwd(),
    extensionFactories: options.extensionFactories,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager,
    skillsOverride: () => ({ skills: options.skills ?? [], diagnostics: [] }),
    systemPrompt: options.systemPrompt ?? "phase-zero AgentSession",
  });

  await resourceLoader.reload();

  const created = await createAgentSession({
    agentDir,
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.excludeTools ? { excludeTools: options.excludeTools } : {}),
    cwd: options.sessionManager.getCwd(),
    model,
    modelRuntime,
    resourceLoader,
    sessionManager: options.sessionManager,
    settingsManager,
  });

  await created.session.bindExtensions({
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    ...(options.onExtensionError !== undefined ? { onError: options.onExtensionError } : {}),
    ...(options.uiContext !== undefined ? { uiContext: options.uiContext } : {}),
  });

  return created.session;
};
