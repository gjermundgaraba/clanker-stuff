import type {
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type KeyId,
  type OverlayHandle,
  type OverlayOptions,
  type OverlayUnfocusOptions,
  type TUI,
} from "@earendil-works/pi-tui";

type CustomUiComponent = Component & { dispose?: () => void };
type TestKeybindings = Pick<KeybindingsManager, "matches" | "getKeys">;
type CustomUiFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: T) => void,
) => CustomUiComponent | Promise<CustomUiComponent>;
interface MockTuiOptions {
  rows?: number;
}
interface CustomUiDriverOptions {
  tui?: TUI;
  theme?: Theme;
  keybindings?: KeybindingsManager;
  width?: number;
  keys?: string[];
  captureRender?: "before" | "after" | "before-and-after";
  onAfterCapture?: () => void | Promise<void>;
  onComponent?: (component: CustomUiComponent) => void | Promise<void>;
}
interface CustomUiRunResult<T> {
  component: CustomUiComponent;
  handle: OverlayHandle;
  rendered: string[];
  result: T | undefined;
}
type CustomUiOptions = NonNullable<Parameters<ExtensionUIContext["custom"]>[1]>;

const toKeyId = (key: string): KeyId => {
  switch (key) {
    case "\r":
      return "enter";
    case "\u001B":
      return "escape";
    case "\t":
      return "tab";
    case " ":
      return "space";
    default:
      // SAFETY: Callers provide valid Pi key IDs; raw control sequences are normalized above.
      return key as KeyId;
  }
};

const createOverlayHandle = (remove?: () => void): OverlayHandle => {
  let focused = true;
  let hidden = false;
  return {
    focus() {
      focused = true;
    },
    hide() {
      focused = false;
      remove?.();
    },
    isFocused: () => focused,
    isHidden: () => hidden,
    setHidden(nextHidden: boolean) {
      hidden = nextHidden;
      if (hidden) focused = false;
    },
    unfocus(_options?: OverlayUnfocusOptions) {
      focused = false;
    },
  };
};

export const createIdentityTheme = (): Theme => {
  const theme = {
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
    inverse: (text: string) => text,
    italic: (text: string) => text,
    strikethrough: (text: string) => text,
    underline: (text: string) => text,
  };
  // SAFETY: Every harness consumer uses only these identity formatting methods; Theme's private state is inaccessible.
  return theme as Theme;
};

export const createMockTui = (options: MockTuiOptions = {}): TUI => {
  const overlays: Array<{ handle: OverlayHandle; options?: OverlayOptions }> = [];
  const tui = {
    hasOverlay: () =>
      overlays.some(
        ({ handle, options: overlayOptions }) =>
          !handle.isHidden() && overlayOptions?.visible?.(0, 0) !== false,
      ),
    hideOverlay() {
      overlays.pop()?.handle.unfocus();
    },
    requestRender() {},
    showOverlay(_component: Component, overlayOptions?: OverlayOptions) {
      let entry: (typeof overlays)[number];
      let handle: OverlayHandle;
      handle = createOverlayHandle(() => {
        const index = overlays.indexOf(entry);
        if (index !== -1) {
          overlays.splice(index, 1);
        }
      });
      entry = { handle };
      if (overlayOptions !== undefined) {
        entry.options = overlayOptions;
      }
      overlays.push(entry);
      return handle;
    },
    terminal: { rows: options.rows ?? 40 },
  };
  // SAFETY: Harness consumers use only the implemented overlay methods, requestRender, and terminal.rows.
  return Object.assign({} as TUI, tui);
};

export const createKeybindings = (
  bindings: Partial<Record<string, string[]>> = {},
): KeybindingsManager => {
  const keybindings: TestKeybindings = {
    getKeys: (keybinding) => (bindings[keybinding] ?? []).map(toKeyId),
    matches: (data, keybinding) => bindings[keybinding]?.includes(data) ?? false,
  };
  // SAFETY: The harness exercises only matches/getKeys; the remaining members are private configuration state.
  return keybindings as KeybindingsManager;
};

export const renderComponent = (component: Component | undefined, width = 80): string | undefined =>
  component?.render(width).join("\n");

async function runCustomUi<T>(
  factory: CustomUiFactory<T>,
  options: CustomUiDriverOptions = {},
  customOptions?: CustomUiOptions,
): Promise<CustomUiRunResult<T>> {
  const theme = options.theme ?? createIdentityTheme();
  const keybindings = options.keybindings ?? createKeybindings();
  const tui = options.tui ?? createMockTui();
  const width = options.width ?? 80;
  const rendered: string[] = [];
  let resolved = false;
  let result: T | undefined;
  const pending = Promise.withResolvers<T>();

  const done = (value: T) => {
    if (resolved) {
      return;
    }
    if (customOptions?.overlay) {
      tui.hideOverlay();
    }
    resolved = true;
    result = value;
    pending.resolve(value);
  };

  const component = await factory(tui, theme, keybindings, done);
  let handle = createOverlayHandle();
  const mounted = !resolved;
  if (mounted) {
    const configuredOverlayOptions = customOptions?.overlayOptions;
    const overlayOptions =
      configuredOverlayOptions instanceof Function
        ? configuredOverlayOptions()
        : configuredOverlayOptions;
    handle = customOptions?.overlay
      ? tui.showOverlay(component, overlayOptions)
      : createOverlayHandle();
    customOptions?.onHandle?.(handle);
  }

  try {
    if (mounted) {
      await options.onComponent?.(component);

      if (options.captureRender === "before" || options.captureRender === "before-and-after") {
        rendered.push(renderComponent(component, width) ?? "");
      }

      for (const key of options.keys ?? []) {
        component.handleInput?.(key);
        if (resolved) break;
      }

      if (options.captureRender === "after" || options.captureRender === "before-and-after") {
        rendered.push(renderComponent(component, width) ?? "");
      }

      await options.onAfterCapture?.();
    }

    if (!resolved) {
      result = await pending.promise;
    }

    return { component, handle, rendered, result };
  } finally {
    if (mounted) {
      component.dispose?.();
    }
  }
}

export const createCustomUiDriver = (options: CustomUiDriverOptions = {}) => {
  const rendered: string[] = [];
  let component: CustomUiComponent | undefined;
  let handle = createOverlayHandle();

  async function runWithState<TResult>(
    factory: CustomUiFactory<TResult>,
    runOptions: CustomUiDriverOptions,
    customOptions?: CustomUiOptions,
  ): Promise<CustomUiRunResult<TResult>> {
    const onComponent = runOptions.onComponent;
    const result = await runCustomUi(
      factory,
      {
        ...runOptions,
        async onComponent(nextComponent) {
          component = nextComponent;
          await onComponent?.(nextComponent);
        },
      },
      {
        ...customOptions,
        onHandle(nextHandle) {
          handle = nextHandle;
          customOptions?.onHandle?.(nextHandle);
        },
      },
    );

    rendered.push(...result.rendered);
    return result;
  }

  const custom: ExtensionUIContext["custom"] = async <TResult>(
    factory: CustomUiFactory<TResult>,
    customOptions?: CustomUiOptions,
  ): Promise<TResult> => {
    const result = await runWithState(factory, options, customOptions);
    // SAFETY: runCustomUi waits until the custom component supplies a result.
    return result.result as TResult;
  };

  return {
    get component() {
      return component;
    },
    custom,
    get handle() {
      return handle;
    },
    getLastRender() {
      return rendered.at(-1);
    },
  };
};
