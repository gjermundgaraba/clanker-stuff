import { mkdir } from "node:fs/promises";
import path from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Api, Model, Transport } from "@earendil-works/pi-ai";
import type {
  CompactionSettings,
  ExtensionError,
  ExtensionFactory,
  ExtensionUIContext,
  RetrySettings,
  SessionManager,
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
  compaction?: CompactionSettings;
  extensionFactories: ExtensionFactory[];
  model?: Model<Api>;
  retry?: RetrySettings;
  rootDir: string;
  sessionManager: SessionManager;
  transport?: Transport;
  onExtensionError?: (error: ExtensionError) => void;
  uiContext?: ExtensionUIContext;
  systemPrompt?: string;
}

/** Creates a real AgentSession through public Pi APIs. */
export const createRealCodexSession = async (
  options: RealCodexSessionOptions
) => {
  const agentDir = path.join(
    options.rootDir,
    `agent-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await mkdir(agentDir, { recursive: true });

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  const apiKey = options.apiKey ?? SPIKE_API_KEY;
  const model = options.model ?? SPIKE_MODEL;
  modelRuntime.registerProvider(model.provider, {
    api: model.api,
    apiKey,
    baseUrl: model.baseUrl,
    models: [
      {
        api: model.api,
        contextWindow: model.contextWindow,
        cost: model.cost,
        id: model.id,
        input: model.input,
        maxTokens: model.maxTokens,
        name: model.name,
        reasoning: model.reasoning,
      },
    ],
  });
  if (apiKey) {
    await modelRuntime.setRuntimeApiKey(model.provider, apiKey);
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: options.compaction,
    retry: options.retry,
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
    systemPrompt: options.systemPrompt ?? "phase-zero AgentSession",
  });
  await resourceLoader.reload();

  const created = await createAgentSession({
    agentDir,
    cwd: options.sessionManager.getCwd(),
    model,
    modelRuntime,
    resourceLoader,
    sessionManager: options.sessionManager,
    settingsManager,
  });
  await created.session.bindExtensions({
    onError: options.onExtensionError,
    uiContext: options.uiContext,
  });

  return created.session;
};
