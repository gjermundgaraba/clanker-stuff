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
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { vi } from "vitest";

import { createIdentityTheme } from "./tui.js";

type ExtensionEventName = string;
type ContextOverrides = Omit<Partial<ExtensionCommandContext>, "ui"> & {
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

const createTurnEndEvent = (event?: Partial<TurnEndEvent>): TurnEndEvent => ({
  message:
    event?.message ??
    ({
      api: "faux",
      content: [{ text: "done", type: "text" }],
      model: "faux-1",
      provider: "faux",
      role: "assistant",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0,
          total: 0,
        },
        input: 0,
        output: 0,
        totalTokens: 0,
      },
    } as TurnEndEvent["message"]),
  toolResults: event?.toolResults ?? [],
  turnIndex: event?.turnIndex ?? 0,
  type: "turn_end",
});

const createToolInfo = (name: string): ToolInfo => ({
  description: name,
  name,
  parameters: {} as never,
  sourceInfo: TEST_SOURCE_INFO,
});

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
  let thinkingLevel = "off" as ReturnType<ExtensionAPI["getThinkingLevel"]>;
  let activeTools = [
    ...(options.activeTools ?? ["read", "bash", "edit", "write"]),
  ];
  const baseToolInfos = (
    options.allTools ?? ["read", "bash", "edit", "write"]
  ).map(createToolInfo);
  const knownToolNames = new Set(baseToolInfos.map(({ name }) => name));
  let allToolInfos = [...baseToolInfos];
  let editorText = "";

  const getHandlers = () => extension?.handlers ?? new Map();

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

  const getEntry = (entryId: string) =>
    entries.find((entry) => entry.id === entryId);

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
    ctx: ExtensionContext
  ) => {
    const eventHandlers = getHandlers().get(eventName) ?? [];
    const runAt = async (
      index: number,
      results: unknown[]
    ): Promise<unknown[]> => {
      if (index >= eventHandlers.length) {
        return results;
      }
      results.push(await eventHandlers[index](event as never, ctx));
      return await runAt(index + 1, results);
    };
    return await runAt(0, []);
  };

  const buildContext = (overrides: ContextOverrides = {}) => {
    const notify = vi.fn<(...args: never[]) => unknown>(
      (message: string, type?: string) => {
        notifications.push({ message, type });
      }
    );

    const setWidget = vi.fn<(...args: never[]) => unknown>(
      (key: string, content: string[] | undefined) => {
        widgetState.set(key, content?.join("\n"));
      }
    ) as ExtensionCommandContext["ui"]["setWidget"];

    const onTerminalInput = vi.fn<(...args: never[]) => unknown>(
      (handler: TerminalInputHandler) => {
        terminalInputHandlers.add(handler);
        return () => {
          terminalInputHandlers.delete(handler);
        };
      }
    );

    const ui = {
      addAutocompleteProvider: vi.fn<(...args: never[]) => unknown>(
        (factory: AutocompleteProviderFactory) => {
          autocompleteProviderFactories.push(factory);
        }
      ),
      custom: vi.fn<(...args: never[]) => unknown>(async () => {
        await Promise.resolve();
        throw new Error(
          "Tests using ui.custom must provide ctx.ui.custom explicitly"
        );
      }) as ExtensionCommandContext["ui"]["custom"],
      getEditorComponent: vi.fn<(...args: never[]) => unknown>(
        () => editorFactory
      ),
      getEditorText: vi.fn<(...args: never[]) => unknown>(() => editorText),
      notify,
      onTerminalInput,
      select: vi.fn<(...args: never[]) => unknown>(
        async (): Promise<string | undefined> => {
          await Promise.resolve();
          return undefined;
        }
      ),
      setEditorComponent: vi.fn<(...args: never[]) => unknown>(
        (factory: EditorFactory | undefined) => {
          editorFactory = factory;
        }
      ),
      setEditorText: vi.fn<(...args: never[]) => unknown>((text: string) => {
        editorText = text;
      }),
      setFooter: vi.fn<(...args: never[]) => unknown>(),
      setStatus: vi.fn<(...args: never[]) => unknown>(
        (key: string, text: string | undefined) => {
          statuses.set(key, text);
        }
      ),
      setWidget,
      theme: createIdentityTheme(),
    } as unknown as ExtensionCommandContext["ui"];

    const baseContext = {
      abort: vi.fn<(...args: never[]) => unknown>(),
      cwd: process.cwd(),
      getContextUsage: vi.fn<(...args: never[]) => unknown>(
        (): undefined => undefined
      ),
      hasUI: options.hasUI ?? true,
      isIdle: vi.fn<(...args: never[]) => unknown>(() => true),
      isProjectTrusted: vi.fn<(...args: never[]) => unknown>(() => true),
      mode: "tui" as const,
      model: options.model,
      modelRegistry: {
        find: vi.fn<(...args: never[]) => unknown>(() => null),
        getProviderAuth: vi.fn<(...args: never[]) => unknown>(
          async (): Promise<undefined> => {
            await Promise.resolve();
          }
        ),
      } as unknown as ExtensionContext["modelRegistry"],
      sessionManager: {
        buildContextEntries: getBranch,
        getBranch,
        getEntries: () => [...entries],
        getLeafId: () => leafId,
        getSessionFile: vi.fn<() => string | undefined>(),
        getSessionId: () => sessionId,
      },
      ui,
    } as unknown as ExtensionCommandContext;

    return {
      ...baseContext,
      ...overrides,
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
      throw new Error(
        loaded.errors.map(({ error, path }) => `${path}: ${error}`).join("\n")
      );
    }

    [extension] = loaded.extensions;
    if (!extension) {
      throw new Error("Inline test extension did not load");
    }

    for (const [name, value] of Object.entries(options.flags ?? {})) {
      loaded.runtime.flagValues.set(name, value);
    }

    const runnerContext = buildContext();
    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      process.cwd(),
      runnerContext.sessionManager as unknown as ConstructorParameters<
        typeof ExtensionRunner
      >[3],
      runnerContext.modelRegistry as unknown as ConstructorParameters<
        typeof ExtensionRunner
      >[4]
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
      ...(previousSessionFile === undefined ? {} : { previousSessionFile }),
      reason,
      type: "session_start",
    };

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
    const inputHandlers = getHandlers().get("input") ?? [];

    const runAt = async (
      index: number,
      currentEvent: InputEvent
    ): Promise<
      InputEventResult | { kind: "continue"; currentEvent: InputEvent }
    > => {
      if (index >= inputHandlers.length) {
        return { currentEvent, kind: "continue" };
      }

      const result = (await inputHandlers[index](currentEvent, ctx)) as
        | InputEventResult
        | undefined;
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

    return await command.handler(args, ctx);
  };

  const runTool = async (
    name: string,
    params: unknown,
    ctxOrOptions: ExtensionCommandContext | RunToolOptions = buildContext(),
    toolRunOptions: RunToolOptions = {}
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

    const preparedParams = tool.definition.prepareArguments
      ? tool.definition.prepareArguments(params)
      : (params as never);

    return await tool.definition.execute(
      runOptions.toolCallId ?? name,
      preparedParams,
      runOptions.signal,
      runOptions.onUpdate,
      runOptions.ctx ?? buildContext()
    );
  };

  const runShortcut = async (name: string, ctx = buildContext()) => {
    await ready;
    const shortcut = extension?.shortcuts.get(name as never);
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
    getMessageRenderer(customType: string) {
      return extension?.messageRenderers.get(customType) as
        | MessageRenderer
        | undefined;
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
      const results = [...terminalInputHandlers].map((handler) =>
        handler(data)
      );
      return {
        consumed: results.some((result) => result?.consume),
        results,
      };
    },
  };
};

export type ExtensionHost = ReturnType<typeof createExtensionHost>;
export type { ContextOverrides };
