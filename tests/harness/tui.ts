import type {
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, KeyId, TUI } from "@earendil-works/pi-tui";

type TestKeybindings = Pick<KeybindingsManager, "matches" | "getKeys">;
type CustomUiComponent = Component & { dispose?: () => void };
interface Renderable {
  render: (width: number) => string[];
}
interface MockTuiOptions {
  columns?: number;
  rows?: number;
}
interface CustomUiDriverOptions<T = unknown> {
  tui?: TUI;
  theme?: Theme;
  keybindings?: TestKeybindings;
  width?: number;
  keys?: string[];
  captureRender?: "before" | "after" | "before-and-after";
  onComponent?: (component: CustomUiComponent) => void | Promise<void>;
  resolveWith?: T | ((component: CustomUiComponent) => T | Promise<T>);
}
interface CustomUiRunResult<T> {
  component: CustomUiComponent;
  rendered: string[];
  result: T | undefined;
}

const toKeyId = (key: string): KeyId => {
  switch (key) {
    case "\r": {
      return "enter";
    }
    case "\u001B": {
      return "escape";
    }
    case "\t": {
      return "tab";
    }
    case " ": {
      return "space";
    }
    default: {
      return key as KeyId;
    }
  }
};

const toKeybindingsManager = (
  keybindings: TestKeybindings
): KeybindingsManager => keybindings as unknown as KeybindingsManager;

export const createIdentityTheme = (): Theme =>
  ({
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
    italic: (text: string) => text,
    strikethrough: (text: string) => text,
  }) as unknown as Theme;

const noop = (): void => {
  /* noop */
};

export const createMockTui = (options: MockTuiOptions = {}) => {
  const overlayHandle = {
    focus: noop,
    hide: noop,
    isFocused: () => false,
    isHidden: () => false,
    setHidden: noop,
    unfocus: noop,
  };

  const terminal = {
    clearFromCursor: noop,
    clearLine: noop,
    clearScreen: noop,
    get columns() {
      return options.columns ?? 80;
    },
    drainInput: async () => {
      await Promise.resolve();
    },
    get height() {
      return options.rows ?? 40;
    },
    hideCursor: noop,
    get kittyProtocolActive() {
      return false;
    },
    moveBy: noop,
    get rows() {
      return options.rows ?? 40;
    },
    setTitle: noop,
    showCursor: noop,
    start: noop,
    stop: noop,
    get width() {
      return options.columns ?? 80;
    },
    write: noop,
  } as unknown as TUI["terminal"];

  return {
    requestRender: noop,
    showOverlay: () => overlayHandle,
    terminal,
  } as unknown as TUI;
};

export const createKeybindings = (
  bindings: Partial<Record<string, string[]>> = {}
): TestKeybindings => ({
  getKeys(keybinding) {
    return (bindings[keybinding] ?? []).map(toKeyId);
  },
  matches(data, keybinding) {
    return bindings[keybinding]?.includes(data) ?? false;
  },
});

export const renderComponent = (
  component: unknown,
  width = 80
): string | undefined => {
  if (
    component &&
    typeof component === "object" &&
    "render" in component &&
    typeof component.render === "function"
  ) {
    return (component as Renderable).render(width).join("\n");
  }

  return undefined;
};

const runCustomUi = async <T>(
  factory: Parameters<ExtensionUIContext["custom"]>[0],
  options: CustomUiDriverOptions<T> = {}
): Promise<CustomUiRunResult<T>> => {
  const theme = options.theme ?? (createIdentityTheme() as unknown as Theme);
  const keybindings = toKeybindingsManager(
    options.keybindings ?? createKeybindings()
  );
  const tui = options.tui ?? createMockTui();
  const width = options.width ?? 80;
  const rendered: string[] = [];
  let resolved = false;
  let result: T | undefined;

  const done = (value: T) => {
    resolved = true;
    result = value;
  };

  const component = (await factory(
    tui,
    theme,
    keybindings,
    done as Parameters<typeof factory>[3]
  )) as CustomUiComponent;

  await options.onComponent?.(component);

  if (
    options.captureRender === "before" ||
    options.captureRender === "before-and-after"
  ) {
    rendered.push(renderComponent(component, width) ?? "");
  }

  for (const key of options.keys ?? []) {
    component.handleInput?.(key);
    if (resolved) {
      break;
    }
  }

  if (
    options.captureRender === "after" ||
    options.captureRender === "before-and-after"
  ) {
    rendered.push(renderComponent(component, width) ?? "");
  }

  if (!resolved && options.resolveWith !== undefined) {
    const { resolveWith } = options;
    result =
      typeof resolveWith === "function"
        ? await (
            resolveWith as (component: CustomUiComponent) => T | Promise<T>
          )(component)
        : resolveWith;
  }

  return {
    component,
    rendered,
    result,
  };
};

export const createCustomUiDriver = <T = unknown>(
  options: CustomUiDriverOptions<T> = {}
) => {
  const rendered: string[] = [];

  const run = async (
    factory: Parameters<ExtensionUIContext["custom"]>[0],
    overrides: CustomUiDriverOptions<T> = {}
  ) => {
    const result = await runCustomUi(factory, { ...options, ...overrides });

    rendered.push(...result.rendered);
    return result;
  };

  const custom = (async <TResult>(
    factory: Parameters<ExtensionUIContext["custom"]>[0]
  ) => {
    const result = await run(factory);
    return result.result as TResult;
  }) as ExtensionUIContext["custom"];

  return {
    custom,
    getLastRender() {
      return rendered.at(-1);
    },
    run,
  };
};
