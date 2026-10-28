import { inspect } from "node:util";

import {
  InMemoryCredentialStore,
  Type,
  fauxAssistantMessage,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import type { JsonObject, JsonValue, Provider } from "@earendil-works/pi-ai";
import { makeStrictJsonSchema } from "@earendil-works/pi-ai/api/constrained-sampling";
import type {
  AutocompleteProviderFactory,
  BuildSystemPromptOptions,
  EntryRenderer,
  Extension,
  ExtensionAPI,
  ExtensionActions,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
  ExtensionContextActions,
  MarkdownTransformer,
  NormalizedBuildSystemPromptOptions,
  ProviderConfig,
  InputEvent,
  InputEventResult,
  RegisteredCommand,
  RegisteredTool,
  SlashCommandInfo,
  SessionEntry,
  SessionShutdownEvent,
  SessionStartEvent,
  TerminalInputHandler,
  ToolInfo,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
  buildSessionProjection,
  createEventBus,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { vi } from "vite-plus/test";

import { createIdentityTheme } from "./tui.js";

type ExtensionEventName = string;

type ContextOverrides = Omit<
  Partial<ExtensionCommandContext>,
  "modelRegistry" | "sessionManager" | "ui"
> & {
  modelRegistry?: Partial<ExtensionContext["modelRegistry"]>;
  sessionManager?: Partial<ExtensionContext["sessionManager"]>;
  ui?: Partial<ExtensionCommandContext["ui"]>;
};

type ToolExecute = NonNullable<
  Parameters<ExtensionAPI["registerTool"]>[0]["execute"]
>;

type EditorFactory = Parameters<
  ExtensionCommandContext["ui"]["setEditorComponent"]
>[0];

type MessageRenderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];

type NativeProvider = Provider;

type ToolContextOverrides = ContextOverrides &
  Partial<Pick<ExtensionToolContext, "tools" | "executeTool">>;

interface RunToolOptions {
  ctx?: ExtensionToolContext;
  signal?: Parameters<ToolExecute>[2];
  onUpdate?: Parameters<ToolExecute>[3];
  toolCallId?: Parameters<ToolExecute>[0];
}

export interface ExtensionHostOptions {
  entries?: SessionEntry[];
  leafId?: string | null;
  hasUI?: boolean;
  activeTools?: string[];
  allTools?: string[];
  externalTools?: string[];
  commands?: SlashCommandInfo[];
  flags?: Record<string, boolean | string>;
  model?: ExtensionContext["model"];
  sessionId?: string;
}

const TEST_SOURCE_INFO = createSyntheticSourceInfo("<test>", {
  origin: "top-level",
  scope: "project",
  source: "test",
});

let nextHostId = 0;

const InputEventResultSchema = Type.Union([
  Type.Object({ action: Type.Literal("continue") }),
  Type.Object({
    action: Type.Literal("transform"),
    images: Type.Optional(
      Type.Array(
        Type.Object({
          data: Type.String(),
          mimeType: Type.String(),
          type: Type.Literal("image"),
        })
      )
    ),
    text: Type.String(),
  }),
  Type.Object({ action: Type.Literal("handled") }),
]);

export const normalizedSystemPromptOptions = (
  input: BuildSystemPromptOptions
): NormalizedBuildSystemPromptOptions => ({
  ...(input.customPrompt === undefined
    ? {}
    : { customPrompt: input.customPrompt }),
  ...(input.forceSystemPrompt === undefined
    ? {}
    : { forceSystemPrompt: input.forceSystemPrompt }),
  appendSystemPrompt: input.appendSystemPrompt ?? "",
  contextFiles: (input.contextFiles ?? []).map((file) => ({ ...file })),
  cwd: input.cwd,
  hiddenTools: [...(input.hiddenTools ?? [])],
  promptGuidelines: [...(input.promptGuidelines ?? [])],
  sections: { ...input.sections },
  selectedTools: [
    ...(input.selectedTools ?? ["read", "bash", "edit", "write"]),
  ],
  skills: (input.skills ?? []).map((skill) => ({ ...skill })),
  toolGuidelines: Object.fromEntries(
    Object.entries(input.toolGuidelines ?? {}).map(([name, guidelines]) => [
      name,
      [...guidelines],
    ])
  ),
  toolSnippets: { ...input.toolSnippets },
});

const notImplemented = (member: string) => (): never => {
  throw new Error(`${member} is not implemented in harness`);
};

const contextModelRuntime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
});

const createTurnEndEvent = (
  event: Partial<TurnEndEvent> = {}
): TurnEndEvent => ({
  context: {
    canContinue: false,
    contextEntries: [],
    contextMessages: [],
    llmMessages: [],
    pendingMessages: [],
  },
  continue: false,
  entries: [],
  message: fauxAssistantMessage("done"),
  messageEntryId: "test-assistant",
  outcome: "completed",
  toolResultEntryIds: [],
  toolResults: [],
  turnIndex: 0,
  ...event,
  type: "turn_end",
});

const createToolInfo = (name: string, external: boolean): ToolInfo => ({
  description: name,
  name,
  parameters: Type.Object({}),
  exposure: "direct",
  sourceInfo: external
    ? TEST_SOURCE_INFO
    : createSyntheticSourceInfo(`builtin:${name}`, { source: "builtin" }),
});

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (typeof value !== "object") {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every(isJsonValue)
  );
};

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  isJsonValue(value);

const assertStrictRepresentable = (
  tool: Pick<
    RegisteredTool["definition"],
    "constrainedSampling" | "name" | "parameters"
  >
) => {
  if (
    tool.constrainedSampling === undefined ||
    tool.constrainedSampling === false ||
    tool.constrainedSampling.type !== "json_schema"
  ) {
    return;
  }

  try {
    makeStrictJsonSchema(tool.parameters);
  } catch (error) {
    throw new Error(
      `Tool ${tool.name} requests strict sampling with an unrepresentable schema`,
      {
        cause: error,
      }
    );
  }
};

const custom: ExtensionCommandContext["ui"]["custom"] = async () => {
  await Promise.resolve();
  throw new Error(
    "Tests using ui.custom must provide ctx.ui.custom explicitly"
  );
};

export const createExtensionHost = (
  extensionFactory: (pi: ExtensionAPI) => void | Promise<void>,
  options: ExtensionHostOptions = {}
) => {
  const sessionId = options.sessionId ?? `test-session-${(nextHostId += 1)}`;
  const emptyCommands = new Map<string, RegisteredCommand>();
  const emptyTools = new Map<string, RegisteredTool>();
  const registeredNativeProviders = new Map<string, NativeProvider>();
  const registeredProviderConfigs = new Map<string, ProviderConfig>();
  const entries = [...(options.entries ?? [])];
  const appendedEntries: SessionEntry[] = [];

  const sentUserMessages: Array<{
    content: Parameters<ExtensionAPI["sendUserMessage"]>[0];
    options: Parameters<ExtensionAPI["sendUserMessage"]>[1];
  }> = [];

  const sentMessages: Array<{
    message: Parameters<ExtensionAPI["sendMessage"]>[0];
    options: Parameters<ExtensionAPI["sendMessage"]>[1];
  }> = [];

  const notifications: Array<{ message: string; type?: string }> = [];
  const autocompleteProviderFactories: AutocompleteProviderFactory[] = [];
  const widgetState = new Map<string, string | undefined>();
  const statuses = new Map<string, string | undefined>();
  const terminalInputHandlers = new Set<TerminalInputHandler>();
  const events = createEventBus();
  let extension: Extension | undefined;
  let leafId = options.leafId ?? null;
  let nextAppendedEntryId = 1;
  let editorFactory: EditorFactory | undefined;
  let sessionName: string | undefined;
  let thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]> = "off";

  let activeTools = [
    ...(options.activeTools ?? ["read", "bash", "edit", "write"]),
  ];

  const externalToolNames = new Set(options.externalTools);

  const baseToolInfos = (
    options.allTools ?? ["read", "bash", "edit", "write"]
  ).map((name) => createToolInfo(name, externalToolNames.has(name)));

  const activatedOnRegistration = new Set(
    baseToolInfos.map(({ name }) => name)
  );

  let allToolInfos = [...baseToolInfos];
  let editorText = "";

  const syncRegisteredTools = () => {
    if (!extension) {
      return;
    }

    const extensionTools = [...extension.tools.values()];

    const extensionToolNames = new Set(
      extensionTools.map(({ definition }) => definition.name)
    );

    allToolInfos = [
      ...baseToolInfos.filter(({ name }) => !extensionToolNames.has(name)),
      ...extensionTools.map(({ definition, sourceInfo }) => ({
        exposure: definition.exposure ?? "direct",
        description: definition.description,
        name: definition.name,
        parameters: definition.parameters,
        ...(definition.promptGuidelines === undefined
          ? {}
          : { promptGuidelines: definition.promptGuidelines }),
        ...(definition.namespace ? { namespace: definition.namespace } : {}),
        ...(definition.annotations
          ? { annotations: definition.annotations }
          : {}),
        sourceInfo,
      })),
    ];

    for (const { definition } of extensionTools) {
      const exposure = definition.exposure ?? "direct";

      if (exposure === "hidden") {
        activeTools = activeTools.filter((name) => name !== definition.name);
      }

      const activate =
        (exposure === "direct" || exposure === "model-only") &&
        definition.defaultActive !== false;

      if (activate) {
        if (
          !activatedOnRegistration.has(definition.name) &&
          !activeTools.includes(definition.name)
        ) {
          activeTools.push(definition.name);
        }

        activatedOnRegistration.add(definition.name);
      } else {
        activatedOnRegistration.delete(definition.name);
      }
    }
  };

  const getEntry = (entryId: string) =>
    entries.find((entry) => entry.id === entryId);

  const getBranch = (fromId?: string) => {
    const targetId = fromId ?? leafId;

    if (targetId === null || targetId === "") {
      return [];
    }

    const branch: SessionEntry[] = [];
    let currentId: string | null = targetId;

    while (currentId !== null && currentId !== "") {
      const entry = getEntry(currentId);

      if (!entry) {
        break;
      }

      branch.unshift(entry);
      currentId = entry.parentId;
    }

    return branch;
  };

  const emitHandlers = async (
    eventName: ExtensionEventName,
    event: unknown,
    ctx: ExtensionContext
  ) => {
    const eventHandlers = extension?.handlers.get(eventName) ?? [];
    const results: unknown[] = [];

    for (const handler of eventHandlers) {
      results.push(await handler(event, ctx));
    }

    return results;
  };

  const buildContext = (overrides: ContextOverrides = {}) => {
    const notify = vi.fn<ExtensionCommandContext["ui"]["notify"]>(
      (message, type) => {
        notifications.push({
          message,
          ...(type === undefined ? {} : { type }),
        });
      }
    );

    type WidgetFactory = Exclude<
      Parameters<ExtensionCommandContext["ui"]["setWidget"]>[1],
      undefined
    >;

    function setWidget(key: string, content: string[] | undefined): void;
    function setWidget(key: string, content: WidgetFactory | undefined): void;
    function setWidget(
      key: string,
      content: string[] | WidgetFactory | undefined
    ): void {
      widgetState.set(
        key,
        Array.isArray(content) ? content.join("\n") : undefined
      );
    }

    const onTerminalInput = vi.fn<
      ExtensionCommandContext["ui"]["onTerminalInput"]
    >((handler) => {
      terminalInputHandlers.add(handler);

      return () => {
        terminalInputHandlers.delete(handler);
      };
    });

    const ui: ExtensionCommandContext["ui"] = {
      addAutocompleteProvider: vi.fn<
        ExtensionCommandContext["ui"]["addAutocompleteProvider"]
      >((factory) => {
        autocompleteProviderFactories.push(factory);
      }),
      custom,
      getEditorComponent: vi.fn<
        ExtensionCommandContext["ui"]["getEditorComponent"]
      >(() => editorFactory),
      getEditorText: vi.fn<ExtensionCommandContext["ui"]["getEditorText"]>(
        () => editorText
      ),
      notify,
      onTerminalInput,
      select: vi.fn<ExtensionCommandContext["ui"]["select"]>(async () => {
        await Promise.resolve();
      }),
      setEditorComponent: vi.fn<
        ExtensionCommandContext["ui"]["setEditorComponent"]
      >((factory) => {
        editorFactory = factory;
      }),
      setEditorText: vi.fn<ExtensionCommandContext["ui"]["setEditorText"]>(
        (text) => {
          editorText = text;
        }
      ),
      setFooter: vi.fn<ExtensionCommandContext["ui"]["setFooter"]>(),
      setStatus: vi.fn<ExtensionCommandContext["ui"]["setStatus"]>(
        (key, text) => {
          statuses.set(key, text);
        }
      ),
      setWidget,
      theme: createIdentityTheme(),
      confirm: notImplemented("ui.confirm"),
      editor: notImplemented("ui.editor"),
      getAllThemes: notImplemented("ui.getAllThemes"),
      getTheme: notImplemented("ui.getTheme"),
      getToolsExpanded: notImplemented("ui.getToolsExpanded"),
      input: notImplemented("ui.input"),
      pasteToEditor: notImplemented("ui.pasteToEditor"),
      setHeader: notImplemented("ui.setHeader"),
      setHiddenThinkingLabel: notImplemented("ui.setHiddenThinkingLabel"),
      setTheme: notImplemented("ui.setTheme"),
      setTitle: notImplemented("ui.setTitle"),
      setToolsExpanded: notImplemented("ui.setToolsExpanded"),
      setWorkingIndicator: notImplemented("ui.setWorkingIndicator"),
      setWorkingMessage: notImplemented("ui.setWorkingMessage"),
      setWorkingVisible: notImplemented("ui.setWorkingVisible"),
    };

    const sessionManagerOverrides = overrides.sessionManager;

    const defaultSessionManager: ExtensionContext["sessionManager"] = {
      buildSessionProjection:
        sessionManagerOverrides?.buildSessionProjection?.bind(
          sessionManagerOverrides
        ) ??
        (() =>
          buildSessionProjection(
            sessionManagerOverrides?.getBranch?.() ?? getBranch()
          )),
      buildContextEntries:
        sessionManagerOverrides?.buildContextEntries?.bind(
          sessionManagerOverrides
        ) ?? getBranch,
      getBranch:
        sessionManagerOverrides?.getBranch?.bind(sessionManagerOverrides) ??
        getBranch,
      getEntries:
        sessionManagerOverrides?.getEntries?.bind(sessionManagerOverrides) ??
        (() => [...entries]),
      getEntry:
        sessionManagerOverrides?.getEntry?.bind(sessionManagerOverrides) ??
        getEntry,
      getLeafEntry:
        sessionManagerOverrides?.getLeafEntry?.bind(sessionManagerOverrides) ??
        (() =>
          leafId === null || leafId === "" ? undefined : getEntry(leafId)),
      getLeafId:
        sessionManagerOverrides?.getLeafId?.bind(sessionManagerOverrides) ??
        (() => leafId),
      getSessionFile:
        sessionManagerOverrides?.getSessionFile?.bind(
          sessionManagerOverrides
        ) ?? (() => undefined),
      getSessionId:
        sessionManagerOverrides?.getSessionId?.bind(sessionManagerOverrides) ??
        (() => sessionId),
      getCwd: notImplemented("sessionManager.getCwd"),
      getHeader: notImplemented("sessionManager.getHeader"),
      getLabel: notImplemented("sessionManager.getLabel"),
      getSessionDir: notImplemented("sessionManager.getSessionDir"),
      getSessionName: notImplemented("sessionManager.getSessionName"),
      getTree: notImplemented("sessionManager.getTree"),
    };

    Object.assign(defaultSessionManager, sessionManagerOverrides);

    const registryMembers: Pick<ModelRegistry, keyof ModelRegistry> = {
      find: vi.fn<ModelRegistry["find"]>(),
      getAvailable: vi.fn<ModelRegistry["getAvailable"]>(() => []),
      getProviderAuth: vi.fn<ModelRegistry["getProviderAuth"]>(
        async () => undefined
      ),
      refresh: vi.fn<ModelRegistry["refresh"]>(async () => ({
        aborted: false,
        errors: new Map(),
      })),
      classify: notImplemented("modelRegistry.classify"),
      complete: notImplemented("modelRegistry.complete"),
      findOfType: notImplemented("modelRegistry.findOfType"),
      generateImages: notImplemented("modelRegistry.generateImages"),
      getAll: notImplemented("modelRegistry.getAll"),
      getApiKeyAndHeaders: notImplemented("modelRegistry.getApiKeyAndHeaders"),
      getApiKeyForProvider: notImplemented(
        "modelRegistry.getApiKeyForProvider"
      ),
      getAvailableOfType: notImplemented("modelRegistry.getAvailableOfType"),
      getError: notImplemented("modelRegistry.getError"),
      getModelOfType: notImplemented("modelRegistry.getModelOfType"),
      getModelsOfType: notImplemented("modelRegistry.getModelsOfType"),
      getProvider: notImplemented("modelRegistry.getProvider"),
      getProviderAuthStatus: notImplemented(
        "modelRegistry.getProviderAuthStatus"
      ),
      getProviderDisplayName: notImplemented(
        "modelRegistry.getProviderDisplayName"
      ),
      getRegisteredNativeProvider: notImplemented(
        "modelRegistry.getRegisteredNativeProvider"
      ),
      getRegisteredProviderConfig: notImplemented(
        "modelRegistry.getRegisteredProviderConfig"
      ),
      getRegisteredProviderIds: notImplemented(
        "modelRegistry.getRegisteredProviderIds"
      ),
      hasConfiguredAuth: notImplemented("modelRegistry.hasConfiguredAuth"),
      isUsingOAuth: notImplemented("modelRegistry.isUsingOAuth"),
      registerProvider: notImplemented("modelRegistry.registerProvider"),
      registerVirtualModel: notImplemented(
        "modelRegistry.registerVirtualModel"
      ),
      stream: notImplemented("modelRegistry.stream"),
      streamSimple: notImplemented("modelRegistry.streamSimple"),
      unregisterProvider: notImplemented("modelRegistry.unregisterProvider"),
      unregisterVirtualModel: notImplemented(
        "modelRegistry.unregisterVirtualModel"
      ),
    };

    const modelRegistry = Object.assign(
      new ModelRegistry(contextModelRuntime),
      registryMembers
    );

    Object.assign(modelRegistry, overrides.modelRegistry);

    const baseContext: ExtensionCommandContext = {
      abort: vi.fn<ExtensionCommandContext["abort"]>(),
      cwd: process.cwd(),
      getContextUsage: vi.fn<ExtensionCommandContext["getContextUsage"]>(),
      hasUI: options.hasUI ?? true,
      isIdle: vi.fn<ExtensionCommandContext["isIdle"]>(() => true),
      isProjectTrusted: vi.fn<ExtensionCommandContext["isProjectTrusted"]>(
        () => true
      ),
      mode: "tui" as const,
      model: options.model,
      modelRegistry,
      sessionManager: defaultSessionManager,
      ui,
      scopedModels: [],
      signal: undefined,
      compact: notImplemented("compact"),
      fork: notImplemented("fork"),
      getSystemPrompt: notImplemented("getSystemPrompt"),
      getSystemPromptOptions: notImplemented("getSystemPromptOptions"),
      hasPendingMessages: notImplemented("hasPendingMessages"),
      navigateTree: notImplemented("navigateTree"),
      newSession: notImplemented("newSession"),
      reload: notImplemented("reload"),
      shutdown: notImplemented("shutdown"),
      switchSession: notImplemented("switchSession"),
      waitForIdle: notImplemented("waitForIdle"),
    };

    return {
      ...baseContext,
      ...overrides,
      modelRegistry,
      sessionManager: defaultSessionManager,
      ui: {
        ...ui,
        ...overrides.ui,
      },
    };
  };

  const appendEntry: ExtensionActions["appendEntry"] = (customType, data) => {
    const entry: SessionEntry = {
      customType,
      data,
      id: `${customType}-${nextAppendedEntryId}`,
      parentId: leafId,
      timestamp: new Date().toISOString(),
      type: "custom",
    };

    entries.push(entry);
    appendedEntries.push(entry);
    nextAppendedEntryId += 1;
    leafId = entry.id;
  };

  const actions: ExtensionActions = {
    appendEntry,
    getActiveTools: () => [...activeTools],
    getAllTools: () => [...allToolInfos],
    getSettings: () => ({}),
    getCommands: () => [...(options.commands ?? [])],
    getSessionName: () => sessionName,
    getThinkingLevel: () => thinkingLevel,
    refreshTools: syncRegisteredTools,
    sendMessage(message, messageOptions) {
      sentMessages.push({ message, options: messageOptions });
    },
    sendUserMessage(content, messageOptions) {
      sentUserMessages.push({ content, options: messageOptions });
    },
    setActiveTools(toolNames) {
      activeTools = [...toolNames];
    },
    setLabel: vi.fn<ExtensionActions["setLabel"]>(),
    setModel: vi.fn<ExtensionActions["setModel"]>(async () => false),
    setSessionName(name) {
      sessionName = name;
    },
    setThinkingLevel(level) {
      thinkingLevel = level;
    },
  };

  const ready = (async () => {
    const resourceLoader = new DefaultResourceLoader({
      agentDir: process.cwd(),
      cwd: process.cwd(),
      eventBus: events,
      extensionFactories: [extensionFactory],
      noContextFiles: true,
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      settingsManager: SettingsManager.inMemory(),
    });

    await resourceLoader.reload();

    const loaded = resourceLoader.getExtensions();

    if (loaded.errors.length > 0) {
      throw new Error(
        loaded.errors.map(({ error, path }) => `${path}: ${error}`).join("\n")
      );
    }

    [extension] = loaded.extensions;

    if (!extension) {
      throw new Error("Inline test extension did not load");
    }

    for (const { definition } of extension.tools.values()) {
      assertStrictRepresentable(definition);
    }

    for (const [name, value] of Object.entries(options.flags ?? {})) {
      loaded.runtime.flagValues.set(name, value);
    }

    const runnerModelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });

    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      process.cwd(),
      SessionManager.inMemory(process.cwd()),
      new ModelRegistry(runnerModelRuntime)
    );

    const contextActions: ExtensionContextActions = {
      abort: vi.fn<ExtensionContextActions["abort"]>(),
      compact: vi.fn<ExtensionContextActions["compact"]>(),
      getContextUsage: vi.fn<ExtensionContextActions["getContextUsage"]>(),
      getModel: () => options.model,
      getScopedModels: () => [],
      getSignal: vi.fn<ExtensionContextActions["getSignal"]>(),
      getSystemPrompt: () => "",
      hasPendingMessages: () => false,
      isIdle: () => true,
      isProjectTrusted: () => true,
      shutdown: vi.fn<ExtensionContextActions["shutdown"]>(),
    };

    runner.bindCore(actions, contextActions, {
      registerNativeProvider(provider) {
        registeredNativeProviders.set(provider.id, provider);
      },
      registerProvider(name, config) {
        registeredProviderConfigs.set(name, config);
      },
      unregisterProvider(name) {
        registeredNativeProviders.delete(name);
        registeredProviderConfigs.delete(name);
      },
    });
    syncRegisteredTools();
  })();

  const emit = async (
    eventName: ExtensionEventName,
    event: unknown,
    ctx = buildContext()
  ) => {
    await ready;

    return await emitHandlers(eventName, event, ctx);
  };

  const emitSessionStart = async (
    ctx = buildContext(),
    reason: SessionStartEvent["reason"] = "startup",
    previousSessionFile?: string
  ) => {
    const event: SessionStartEvent = {
      reason,
      type: "session_start",
    };

    if (previousSessionFile !== undefined) {
      event.previousSessionFile = previousSessionFile;
    }

    await emit("session_start", event, ctx);
  };

  const emitSessionTree = async (ctx = buildContext()) => {
    await emit(
      "session_tree",
      { newLeafId: leafId, oldLeafId: null, type: "session_tree" },
      ctx
    );
  };

  const emitSessionShutdown = async (
    ctx = buildContext(),
    reason: SessionShutdownEvent["reason"] = "quit"
  ) => {
    const event: SessionShutdownEvent = {
      reason,
      type: "session_shutdown",
    };

    await emit("session_shutdown", event, ctx);
  };

  const emitInput = async (
    event: InputEvent,
    ctx = buildContext()
  ): Promise<InputEventResult> => {
    await ready;
    const inputHandlers = extension?.handlers.get("input") ?? [];

    let currentEvent = event;

    // oxlint-disable-next-line oxc/no-accumulating-spread -- Handlers can retain prior input events; fresh fixed-size snapshots preserve their text and image references.
    for (const handler of inputHandlers) {
      const rawResult = await handler(currentEvent, ctx);

      const result =
        rawResult === undefined
          ? undefined
          : Value.Parse(InputEventResultSchema, rawResult);

      if (!result || result.action === "continue") {
        continue;
      }

      if (result.action === "handled") {
        return result;
      }

      currentEvent = { ...currentEvent, text: result.text };

      if (result.images !== undefined) {
        currentEvent.images = result.images;
      }
    }

    if (
      currentEvent.text !== event.text ||
      currentEvent.images !== event.images
    ) {
      const transformed: InputEventResult = {
        action: "transform",
        text: currentEvent.text,
      };

      if (currentEvent.images !== undefined) {
        Object.assign(transformed, { images: currentEvent.images });
      }

      return transformed;
    }

    return { action: "continue" };
  };

  const emitTurnEnd = async (
    event?: Partial<TurnEndEvent>,
    ctx = buildContext()
  ) => {
    await emit("turn_end", createTurnEndEvent(event), ctx);
  };

  const runCommand = async (name: string, args = "", ctx = buildContext()) => {
    await ready;
    const command = extension?.commands.get(name);

    if (!command) {
      throw new Error(`Extension command not registered: ${name}`);
    }

    await command.handler(args, ctx);
  };

  const createToolContext = (overrides: ToolContextOverrides = {}) => {
    const {
      tools = [],
      executeTool = async () => {
        throw new Error(
          "Use the AgentSession harness to test nested tool execution"
        );
      },
      ...context
    } = overrides;

    return Object.assign(buildContext(context), { tools, executeTool });
  };

  const runTool = async (
    name: string,
    params: JsonObject,
    runOptions: RunToolOptions = {}
  ) => {
    await ready;
    const tool = extension?.tools.get(name);

    if (!tool) {
      throw new Error(`Extension tool not registered: ${name}`);
    }

    assertStrictRepresentable(tool.definition);

    const preparedParams: unknown = tool.definition.prepareArguments
      ? tool.definition.prepareArguments(params)
      : params;

    if (!isJsonObject(preparedParams)) {
      throw new TypeError(
        `prepareArguments for tool "${name}" returned ${inspect(preparedParams)}, not a JSON object`
      );
    }

    const validatedParams: unknown = validateToolArguments(
      {
        description: tool.definition.description,
        name: tool.definition.name,
        parameters: tool.definition.parameters,
      },
      {
        arguments: preparedParams,
        id: runOptions.toolCallId ?? name,
        name,
        type: "toolCall",
      }
    );

    return await tool.definition.execute(
      runOptions.toolCallId ?? name,
      validatedParams,
      runOptions.signal,
      runOptions.onUpdate,
      runOptions.ctx ?? createToolContext()
    );
  };

  const runShortcut = async (name: string, ctx = buildContext()) => {
    await ready;

    const shortcut = [...(extension?.shortcuts.values() ?? [])].find(
      (candidate) => candidate.shortcut === name
    );

    if (!shortcut) {
      throw new Error(`Extension shortcut not registered: ${name}`);
    }

    await shortcut.handler(ctx);
  };

  return {
    createContext: buildContext,
    createToolContext,
    emit,
    emitInput,
    emitSessionShutdown,
    emitSessionStart,
    emitSessionTree,
    emitTurnEnd,
    events,
    getActiveTools() {
      return [...activeTools];
    },
    getAppendedEntries() {
      return [...appendedEntries];
    },
    getAutocompleteProvider(base: AutocompleteProvider) {
      let current = base;

      for (const factory of autocompleteProviderFactories) {
        current = factory(current);
      }

      return current;
    },
    getEditorFactory() {
      return editorFactory;
    },
    getEntryRenderer(customType: string): EntryRenderer | undefined {
      return extension?.entryRenderers?.get(customType);
    },
    getLeafId() {
      return leafId;
    },
    getMarkdownTransformer(): MarkdownTransformer | undefined {
      return extension?.markdownTransformer;
    },
    getMessageRenderer(customType: string): MessageRenderer | undefined {
      return extension?.messageRenderers.get(customType);
    },
    getNotifications() {
      return [...notifications];
    },
    getRegisteredCommands() {
      return extension?.commands ?? emptyCommands;
    },
    getRegisteredNativeProviders() {
      return registeredNativeProviders;
    },
    getRegisteredProviderConfigs() {
      return registeredProviderConfigs;
    },
    getRegisteredTools() {
      return extension?.tools ?? emptyTools;
    },
    getSentMessages() {
      return [...sentMessages];
    },
    getSentUserMessages() {
      return [...sentUserMessages];
    },
    getStatus(key: string) {
      return statuses.get(key);
    },
    getThinkingLevel() {
      return thinkingLevel;
    },
    getWidget(key: string) {
      return widgetState.get(key);
    },
    ready,
    runCommand,
    runShortcut,
    runTool,
    setActiveTools(toolNames: string[]) {
      activeTools = [...toolNames];
    },
    setThinkingLevel(level: ReturnType<ExtensionAPI["getThinkingLevel"]>) {
      thinkingLevel = level;
    },
    setLeafId(id: string | null) {
      leafId = id;
    },
    terminalInput(data: string) {
      const results = [...terminalInputHandlers].map((handler) =>
        handler(data)
      );

      return {
        consumed: results.some((result) => result?.consume === true),
        results,
      };
    },
  };
};

export type ExtensionHost = ReturnType<typeof createExtensionHost>;

export type { ContextOverrides };
