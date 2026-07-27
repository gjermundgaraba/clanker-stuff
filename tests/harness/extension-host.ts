import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  RegisteredCommand,
  RegisteredTool,
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
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

import { createIdentityTheme } from "./tui.js";

type ExtensionEventName = string;
type EventHandler = (...args: unknown[]) => unknown;
type ContextOverrides = Omit<Partial<ExtensionCommandContext>, "ui"> & {
  ui?: Partial<ExtensionCommandContext["ui"]>;
};
type ToolExecute = NonNullable<
  Parameters<ExtensionAPI["registerTool"]>[0]["execute"]
>;
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
  model?: ExtensionContext["model"];
}

const TEST_SOURCE_INFO = createSyntheticSourceInfo("<test>", {
  origin: "top-level",
  scope: "project",
  source: "test",
});

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
  const handlers = new Map<ExtensionEventName, EventHandler[]>();
  const registeredCommands = new Map<string, RegisteredCommand>();
  const registeredTools = new Map<string, RegisteredTool>();
  const registeredShortcuts = new Map<
    string,
    Parameters<ExtensionAPI["registerShortcut"]>[1]
  >();
  const entries = [...(options.entries ?? [])];
  const appendedEntries: SessionEntry[] = [];
  const sentUserMessages: {
    content: Parameters<ExtensionAPI["sendUserMessage"]>[0];
    options: Parameters<ExtensionAPI["sendUserMessage"]>[1];
  }[] = [];
  const notifications: { message: string; type?: string }[] = [];
  const widgetState = new Map<string, string | undefined>();
  const statuses = new Map<string, string | undefined>();
  const terminalInputHandlers = new Set<TerminalInputHandler>();
  const events = createEventBus();
  let leafId = options.leafId ?? null;
  let nextAppendedEntryId = 1;
  let activeTools = [
    ...(options.activeTools ?? ["read", "bash", "edit", "write"]),
  ];
  let allToolInfos = (
    options.allTools ?? ["read", "bash", "edit", "write"]
  ).map(createToolInfo);
  let editorText = "";

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
    const eventHandlers = handlers.get(eventName) ?? [];
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
      custom: vi.fn<(...args: never[]) => unknown>(async () => {
        await Promise.resolve();
        throw new Error(
          "Tests using ui.custom must provide ctx.ui.custom explicitly"
        );
      }) as ExtensionCommandContext["ui"]["custom"],
      getEditorText: vi.fn<(...args: never[]) => unknown>(() => editorText),
      notify,
      onTerminalInput,
      select: vi.fn<(...args: never[]) => unknown>(
        async (): Promise<string | undefined> => {
          await Promise.resolve();
          return undefined;
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
        getProviderAuth: vi.fn<(...args: never[]) => unknown>(
          async (): Promise<undefined> => {
            await Promise.resolve();
            return undefined;
          }
        ),
      } as unknown as ExtensionContext["modelRegistry"],
      sessionManager: {
        getBranch,
        getLeafId: () => leafId,
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

  const pi = {
    appendEntry(customType: string, data: unknown) {
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
    },
    events,
    getActiveTools: () => [...activeTools],
    getAllTools: () => [...allToolInfos],
    getThinkingLevel: () => "off" as never,
    on(event: string, handler: EventHandler) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler as EventHandler);
      handlers.set(event, eventHandlers);
    },
    registerCommand(
      name: string,
      commandOptions: Parameters<ExtensionAPI["registerCommand"]>[1]
    ) {
      registeredCommands.set(name, {
        ...commandOptions,
        name,
        sourceInfo: TEST_SOURCE_INFO,
      } as RegisteredCommand);
    },
    registerShortcut: vi.fn<(...args: never[]) => unknown>(
      (shortcut, shortcutOptions) => {
        registeredShortcuts.set(shortcut, shortcutOptions);
      }
    ),
    registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) {
      const wasKnownTool =
        registeredTools.has(tool.name) ||
        allToolInfos.some((candidate) => candidate.name === tool.name);

      registeredTools.set(tool.name, {
        definition: tool,
        sourceInfo: TEST_SOURCE_INFO,
      } as unknown as RegisteredTool);
      if (!allToolInfos.some((candidate) => candidate.name === tool.name)) {
        allToolInfos = [
          ...allToolInfos,
          {
            description: tool.description,
            name: tool.name,
            parameters: tool.parameters,
            sourceInfo: TEST_SOURCE_INFO,
          },
        ];
      }

      if (!wasKnownTool && !activeTools.includes(tool.name)) {
        activeTools = [...activeTools, tool.name];
      }
    },
    sendUserMessage: vi.fn<(...args: never[]) => unknown>(
      (content, messageOptions) => {
        sentUserMessages.push({ content, options: messageOptions });
      }
    ),
    setActiveTools(toolNames: string[]) {
      activeTools = [...toolNames];
    },
  } as unknown as ExtensionAPI;

  const ready = (async () => {
    const result = extensionFactory(pi);
    await Promise.resolve();
    return result;
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
    reason: SessionStartEvent["reason"] = "startup"
  ) => {
    const event: SessionStartEvent = {
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
    const inputHandlers = handlers.get("input") ?? [];

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
    const command = registeredCommands.get(name);
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
    const tool = registeredTools.get(name);
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
    const shortcut = registeredShortcuts.get(name);
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
    getLeafId() {
      return leafId;
    },
    getNotifications() {
      return [...notifications];
    },
    getRegisteredCommands() {
      return registeredCommands;
    },
    getRegisteredTools() {
      return registeredTools;
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
