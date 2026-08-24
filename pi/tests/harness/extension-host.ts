import {
  InMemoryCredentialStore,
  Type,
  fauxAssistantMessage,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai";
import type {
  AutocompleteProviderFactory,
  EntryRenderer,
  Extension,
  ExtensionAPI,
  ExtensionActions,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionContextActions,
  MarkdownTransformer,
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
import type { Static } from "typebox";
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
type ToolExecute = NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>;
type EditorFactory = Parameters<ExtensionCommandContext["ui"]["setEditorComponent"]>[0];
type MessageRenderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];
type NativeProvider = Provider;
interface RunToolOptions {
  ctx?: ExtensionCommandContext;
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
        }),
      ),
    ),
    text: Type.String(),
  }),
  Type.Object({ action: Type.Literal("handled") }),
]);
const ToolArgumentsSchema = Type.Record(Type.String(), Type.Unknown());
type ToolArguments = Static<typeof ToolArgumentsSchema>;
interface IncompleteTarget {}

// SAFETY: This test-only proxy exposes only implemented members and fails immediately for every other Pi API call.
const incomplete = <T>(value: IncompleteTarget): T =>
  new Proxy(value, {
    get(target, property) {
      if (Reflect.has(target, property)) {
        return Object.getOwnPropertyDescriptor(target, property)?.value;
      }
      throw new Error(`Extension host does not implement ${String(property)}`);
    },
  }) as T;

const createTurnEndEvent = (event?: Partial<TurnEndEvent>): TurnEndEvent => ({
  message: event?.message ?? fauxAssistantMessage("done"),
  toolResults: event?.toolResults ?? [],
  turnIndex: event?.turnIndex ?? 0,
  type: "turn_end",
});

const createToolInfo = (name: string): ToolInfo => ({
  description: name,
  name,
  parameters: Type.Object({}),
  sourceInfo: TEST_SOURCE_INFO,
});

export const createExtensionHost = (
  extensionFactory: (pi: ExtensionAPI) => void | Promise<void>,
  options: ExtensionHostOptions = {},
) => {
  const sessionId = options.sessionId ?? `test-session-${(nextHostId += 1)}`;
  const emptyCommands = new Map<string, RegisteredCommand>();
  const emptyTools = new Map<string, RegisteredTool>();
  const registeredNativeProviders = new Map<string, NativeProvider>();
  const registeredProviderConfigs = new Map<string, ProviderConfig>();
  const entries = [...(options.entries ?? [])];
  const appendedEntries: SessionEntry[] = [];
  const sentUserMessages: {
    content: Parameters<ExtensionAPI["sendUserMessage"]>[0];
    options: Parameters<ExtensionAPI["sendUserMessage"]>[1];
  }[] = [];
  const sentMessages: {
    message: Parameters<ExtensionAPI["sendMessage"]>[0];
    options: Parameters<ExtensionAPI["sendMessage"]>[1];
  }[] = [];
  const notifications: { message: string; type?: string }[] = [];
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
  let activeTools = [...(options.activeTools ?? ["read", "bash", "edit", "write"])];
  const baseToolInfos = (options.allTools ?? ["read", "bash", "edit", "write"]).map(createToolInfo);
  const knownToolNames = new Set(baseToolInfos.map(({ name }) => name));
  let allToolInfos = [...baseToolInfos];
  let editorText = "";

  const getHandlers = () => extension?.handlers ?? new Map();

  const syncRegisteredTools = () => {
    if (!extension) {
      return;
    }

    const extensionTools = [...extension.tools.values()];
    const extensionToolNames = new Set(extensionTools.map(({ definition }) => definition.name));
    allToolInfos = [
      ...baseToolInfos.filter(({ name }) => !extensionToolNames.has(name)),
      ...extensionTools.map(({ definition, sourceInfo }) => ({
        description: definition.description,
        name: definition.name,
        parameters: definition.parameters,
        promptGuidelines: definition.promptGuidelines,
        sourceInfo,
      })),
    ];

    for (const { definition } of extensionTools) {
      if (!knownToolNames.has(definition.name)) {
        knownToolNames.add(definition.name);
        if (!activeTools.includes(definition.name)) {
          activeTools.push(definition.name);
        }
      }
    }
  };

  const getEntry = (entryId: string) => entries.find((entry) => entry.id === entryId);

  const getBranch = (fromId?: string) => {
    const targetId = fromId ?? leafId;
    if (!targetId) {
      return [];
    }

    const branch: SessionEntry[] = [];
    let currentId: string | null = targetId;

    while (currentId) {
      const entry = getEntry(currentId);
      if (!entry) {
        break;
      }

      branch.unshift(entry);
      currentId = entry.parentId;
    }

    return branch;
  };

  const emitHandlers = async <TEvent>(
    eventName: ExtensionEventName,
    event: TEvent,
    ctx: ExtensionContext,
  ) => {
    const eventHandlers = getHandlers().get(eventName) ?? [];
    const runAt = async (index: number, results: unknown[]): Promise<unknown[]> => {
      if (index >= eventHandlers.length) {
        return results;
      }
      results.push(await eventHandlers[index](event, ctx));
      return await runAt(index + 1, results);
    };
    return await runAt(0, []);
  };

  const buildContext = (overrides: ContextOverrides = {}) => {
    const notify = vi.fn<ExtensionCommandContext["ui"]["notify"]>((message, type) => {
      notifications.push({ message, type });
    });

    type WidgetFactory = Exclude<
      Parameters<ExtensionCommandContext["ui"]["setWidget"]>[1],
      undefined
    >;
    function setWidget(key: string, content: string[] | undefined): void;
    function setWidget(key: string, content: WidgetFactory | undefined): void;
    function setWidget(key: string, content: string[] | WidgetFactory | undefined): void {
      widgetState.set(key, Array.isArray(content) ? content.join("\n") : undefined);
    }

    const onTerminalInput = vi.fn<ExtensionCommandContext["ui"]["onTerminalInput"]>((handler) => {
      terminalInputHandlers.add(handler);
      return () => {
        terminalInputHandlers.delete(handler);
      };
    });

    const custom: ExtensionCommandContext["ui"]["custom"] = async () => {
      await Promise.resolve();
      throw new Error("Tests using ui.custom must provide ctx.ui.custom explicitly");
    };

    const ui = incomplete<ExtensionCommandContext["ui"]>({
      addAutocompleteProvider: vi.fn<ExtensionCommandContext["ui"]["addAutocompleteProvider"]>(
        (factory) => {
          autocompleteProviderFactories.push(factory);
        },
      ),
      custom: vi.fn<ExtensionCommandContext["ui"]["custom"]>(custom),
      getEditorComponent: vi.fn<ExtensionCommandContext["ui"]["getEditorComponent"]>(
        () => editorFactory,
      ),
      getEditorText: vi.fn<ExtensionCommandContext["ui"]["getEditorText"]>(() => editorText),
      notify,
      onTerminalInput,
      select: vi.fn<ExtensionCommandContext["ui"]["select"]>(async () => {
        await Promise.resolve();
        return undefined;
      }),
      setEditorComponent: vi.fn<ExtensionCommandContext["ui"]["setEditorComponent"]>((factory) => {
        editorFactory = factory;
      }),
      setEditorText: vi.fn<ExtensionCommandContext["ui"]["setEditorText"]>((text) => {
        editorText = text;
      }),
      setFooter: vi.fn<ExtensionCommandContext["ui"]["setFooter"]>(),
      setStatus: vi.fn<ExtensionCommandContext["ui"]["setStatus"]>((key, text) => {
        statuses.set(key, text);
      }),
      setWidget,
      theme: createIdentityTheme(),
    });

    const sessionManagerOverrides = overrides.sessionManager;
    const defaultSessionManager = incomplete<ExtensionContext["sessionManager"]>({
      buildContextEntries:
        sessionManagerOverrides?.buildContextEntries?.bind(sessionManagerOverrides) ?? getBranch,
      getBranch: sessionManagerOverrides?.getBranch?.bind(sessionManagerOverrides) ?? getBranch,
      getEntries:
        sessionManagerOverrides?.getEntries?.bind(sessionManagerOverrides) ?? (() => [...entries]),
      getEntry: sessionManagerOverrides?.getEntry?.bind(sessionManagerOverrides) ?? getEntry,
      getLeafEntry:
        sessionManagerOverrides?.getLeafEntry?.bind(sessionManagerOverrides) ??
        (() => (leafId ? getEntry(leafId) : undefined)),
      getLeafId:
        sessionManagerOverrides?.getLeafId?.bind(sessionManagerOverrides) ?? (() => leafId),
      getSessionFile:
        sessionManagerOverrides?.getSessionFile?.bind(sessionManagerOverrides) ?? (() => undefined),
      getSessionId:
        sessionManagerOverrides?.getSessionId?.bind(sessionManagerOverrides) ?? (() => sessionId),
    });
    Object.assign(defaultSessionManager, sessionManagerOverrides);

    const modelRegistry = incomplete<ExtensionContext["modelRegistry"]>({
      find: vi.fn<ExtensionContext["modelRegistry"]["find"]>(() => undefined),
      getProviderAuth: vi.fn<ExtensionContext["modelRegistry"]["getProviderAuth"]>(
        async () => undefined,
      ),
    });
    Object.assign(modelRegistry, overrides.modelRegistry);

    const baseContext = incomplete<ExtensionCommandContext>({
      abort: vi.fn<ExtensionCommandContext["abort"]>(),
      cwd: process.cwd(),
      getContextUsage: vi.fn<ExtensionCommandContext["getContextUsage"]>(() => undefined),
      hasUI: options.hasUI ?? true,
      isIdle: vi.fn<ExtensionCommandContext["isIdle"]>(() => true),
      isProjectTrusted: vi.fn<ExtensionCommandContext["isProjectTrusted"]>(() => true),
      mode: "tui" as const,
      model: options.model,
      modelRegistry,
      sessionManager: defaultSessionManager,
      ui,
    });

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
      throw new Error(loaded.errors.map(({ error, path }) => `${path}: ${error}`).join("\n"));
    }

    [extension] = loaded.extensions;
    if (!extension) {
      throw new Error("Inline test extension did not load");
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
      new ModelRegistry(runnerModelRuntime),
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

  const emit = async <TEvent>(
    eventName: ExtensionEventName,
    event: TEvent,
    ctx = buildContext(),
  ) => {
    await ready;
    return await emitHandlers(eventName, event, ctx);
  };

  const emitSessionStart = async (
    ctx = buildContext(),
    reason: SessionStartEvent["reason"] = "startup",
    previousSessionFile?: string,
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
    await emit("session_tree", { newLeafId: leafId, oldLeafId: null, type: "session_tree" }, ctx);
  };

  const emitSessionShutdown = async (
    ctx = buildContext(),
    reason: SessionShutdownEvent["reason"] = "quit",
  ) => {
    const event: SessionShutdownEvent = {
      reason,
      type: "session_shutdown",
    };

    await emit("session_shutdown", event, ctx);
  };

  const emitInput = async (event: InputEvent, ctx = buildContext()): Promise<InputEventResult> => {
    await ready;
    const inputHandlers = getHandlers().get("input") ?? [];

    const runAt = async (
      index: number,
      currentEvent: InputEvent,
    ): Promise<InputEventResult | { kind: "continue"; currentEvent: InputEvent }> => {
      if (index >= inputHandlers.length) {
        return { currentEvent, kind: "continue" };
      }

      const rawResult = await inputHandlers[index](currentEvent, ctx);
      const result =
        rawResult === undefined ? undefined : Value.Parse(InputEventResultSchema, rawResult);
      if (!result || result.action === "continue") {
        return await runAt(index + 1, currentEvent);
      }

      if (result.action === "handled") {
        return result;
      }

      const nextEvent: InputEvent = {
        source: currentEvent.source,
        text: result.text,
        type: currentEvent.type,
      };
      const nextImages = result.images ?? currentEvent.images;
      if (nextImages !== undefined) {
        nextEvent.images = nextImages;
      }

      return await runAt(index + 1, nextEvent);
    };

    const final = await runAt(0, event);
    if (!("kind" in final)) {
      return final;
    }

    const { currentEvent } = final;
    if (currentEvent.text !== event.text || currentEvent.images !== event.images) {
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

  const emitTurnEnd = async (event?: Partial<TurnEndEvent>, ctx = buildContext()) => {
    await emit("turn_end", createTurnEndEvent(event), ctx);
  };

  const runCommand = async (name: string, args = "", ctx = buildContext()) => {
    await ready;
    const command = extension?.commands.get(name);
    if (!command) {
      throw new Error(`Extension command not registered: ${name}`);
    }

    return await command.handler(args, ctx);
  };

  const runTool = async (
    name: string,
    params: ToolArguments,
    ctxOrOptions: ExtensionCommandContext | RunToolOptions = buildContext(),
    toolRunOptions: RunToolOptions = {},
  ) => {
    await ready;
    const tool = extension?.tools.get(name);
    if (!tool) {
      throw new Error(`Extension tool not registered: ${name}`);
    }

    const runOptions =
      ctxOrOptions && "ui" in ctxOrOptions
        ? {
            ...toolRunOptions,
            ctx: ctxOrOptions,
          }
        : ctxOrOptions;

    const rawParams = Value.Parse(ToolArgumentsSchema, params);
    const preparedParams = tool.definition.prepareArguments
      ? tool.definition.prepareArguments(rawParams)
      : rawParams;
    const preparedRecord = Value.Parse(ToolArgumentsSchema, preparedParams);
    const validatedParams = validateToolArguments(
      {
        description: tool.definition.description,
        name: tool.definition.name,
        parameters: tool.definition.parameters,
      },
      {
        arguments: preparedRecord,
        id: runOptions.toolCallId ?? name,
        name,
        type: "toolCall",
      },
    );
    const parsedParams = Value.Parse(tool.definition.parameters, validatedParams);

    return await tool.definition.execute(
      runOptions.toolCallId ?? name,
      parsedParams,
      runOptions.signal,
      runOptions.onUpdate,
      runOptions.ctx ?? buildContext(),
    );
  };

  const runShortcut = async (name: string, ctx = buildContext()) => {
    await ready;
    const shortcut = [...(extension?.shortcuts.values() ?? [])].find(
      (candidate) => candidate.shortcut === name,
    );
    if (!shortcut) {
      throw new Error(`Extension shortcut not registered: ${name}`);
    }

    return await shortcut.handler(ctx);
  };

  return {
    createContext: buildContext,
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
    setLeafId(id: string | null) {
      leafId = id;
    },
    terminalInput(data: string) {
      const results = [...terminalInputHandlers].map((handler) => handler(data));
      return {
        consumed: results.some((result) => result?.consume),
        results,
      };
    },
  };
};

export type ExtensionHost = ReturnType<typeof createExtensionHost>;
export type { ContextOverrides };
