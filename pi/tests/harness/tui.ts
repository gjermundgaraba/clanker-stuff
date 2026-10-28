import { Theme } from "@earendil-works/pi-coding-agent";
import type {
  CustomEditor,
  ExtensionUIContext,
  KeybindingsManager,
  ThemeAppearance,
  ThemeBg,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Loader, matchesKey, TuiMainScreen } from "@earendil-works/pi-tui";
import type {
  Component,
  KeyId,
  OverlayHandle,
  OverlayUnfocusOptions,
  ProgramStatus,
  Terminal,
  TUI,
} from "@earendil-works/pi-tui";

type CustomUiComponent = Component & { dispose?: () => void };

type StatusIndicator = NonNullable<
  Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]
>;

type TestKeybindings = Pick<KeybindingsManager, "matches" | "getKeys">;

type CustomUiFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: T) => void
) => CustomUiComponent | Promise<CustomUiComponent>;

interface MockTuiOptions {
  rows?: number;
  programStatus?: ProgramStatus[];
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
  result: T;
}

type CustomUiOptions = NonNullable<Parameters<ExtensionUIContext["custom"]>[1]>;

const createOverlayHandle = (): OverlayHandle => {
  let focused = true;
  let hidden = false;

  return {
    focus() {
      focused = true;
    },
    hide() {
      focused = false;
    },
    getBounds: () => undefined,
    isFocused: () => focused,
    isHidden: () => hidden,
    setHidden(nextHidden: boolean) {
      hidden = nextHidden;

      if (hidden) {
        focused = false;
      }
    },
    unfocus(_options?: OverlayUnfocusOptions) {
      focused = false;
    },
  };
};

const identity = (text: string) => text;

const TERMINAL_DEFAULT_FOREGROUNDS: ConstructorParameters<typeof Theme>[0] = {
  accent: "",
  bashMode: "",
  border: "",
  borderAccent: "",
  borderMuted: "",
  customMessageLabel: "",
  customMessageText: "",
  dim: "",
  error: "",
  mdCode: "",
  mdCodeBlock: "",
  mdCodeBlockBorder: "",
  mdHeading: "",
  mdHr: "",
  mdLink: "",
  mdLinkUrl: "",
  mdListBullet: "",
  mdQuote: "",
  mdQuoteBorder: "",
  muted: "",
  success: "",
  syntaxComment: "",
  syntaxFunction: "",
  syntaxKeyword: "",
  syntaxNumber: "",
  syntaxOperator: "",
  syntaxPunctuation: "",
  syntaxString: "",
  syntaxType: "",
  syntaxVariable: "",
  text: "",
  thinkingHigh: "",
  thinkingLow: "",
  thinkingMedium: "",
  thinkingMinimal: "",
  thinkingOff: "",
  thinkingText: "",
  thinkingXhigh: "",
  toolDiffAdded: "",
  toolDiffContext: "",
  toolDiffRemoved: "",
  toolOutput: "",
  toolTitle: "",
  userMessageText: "",
  warning: "",
};

const TERMINAL_DEFAULT_BACKGROUNDS: ConstructorParameters<typeof Theme>[1] = {
  customMessageBg: "",
  selectedBg: "",
  toolErrorBg: "",
  toolPendingBg: "",
  toolSuccessBg: "",
  userMessageBg: "",
};

export const createIdentityTheme = (
  appearance: ThemeAppearance = "dark"
): Theme =>
  Object.assign(
    new Theme(
      TERMINAL_DEFAULT_FOREGROUNDS,
      TERMINAL_DEFAULT_BACKGROUNDS,
      "truecolor",
      { appearance }
    ),
    {
      bg: (_color: ThemeBg, text: string) => text,
      bold: identity,
      fg: (_color: ThemeColor, text: string) => text,
      inverse: identity,
      italic: identity,
      strikethrough: identity,
      underline: identity,
    }
  );

const ignore = () => undefined;

const createTerminal = (options: MockTuiOptions): Terminal => ({
  clearFromCursor: ignore,
  clearLine: ignore,
  clearScreen: ignore,
  columns: 80,
  drainInput: async () => undefined,
  hideCursor: ignore,
  kittyProtocolActive: false,
  moveBy: ignore,
  rows: options.rows ?? 40,
  setProgramStatus(status: ProgramStatus) {
    options.programStatus?.push(status);
  },
  setProgress: ignore,
  setTitle: ignore,
  showCursor: ignore,
  start: ignore,
  stop: ignore,
  write: ignore,
});

export const createMockTui = (options: MockTuiOptions = {}): TUI => {
  const tui = new TuiMainScreen(createTerminal(options));

  tui.stop();

  return tui;
};

export const createStatusIndicator = (
  kind: StatusIndicator["kind"]
): StatusIndicator => {
  const loader = new Loader(createMockTui(), identity, identity, "status");

  return Object.assign(loader, {
    dispose: () => {
      loader.stop();
    },
    kind,
    renderInBorder: () => "",
    renderSpinnerInBorder: () => "",
  });
};

export const createKeybindings = (
  bindings: Partial<Record<string, KeyId[]>> = {}
): KeybindingsManager => {
  const keybindings: TestKeybindings = {
    getKeys: (keybinding) => bindings[keybinding] ?? [],
    matches: (data, keybinding) =>
      bindings[keybinding]?.some(
        (key) => key === data || matchesKey(data, key)
      ) ?? false,
  };

  return keybindings as KeybindingsManager;
};

const runCustomUi = async <T>(
  factory: CustomUiFactory<T>,
  options: CustomUiDriverOptions = {},
  customOptions?: CustomUiOptions
): Promise<CustomUiRunResult<T>> => {
  const theme = options.theme ?? createIdentityTheme();
  const keybindings = options.keybindings ?? createKeybindings();
  const tui = options.tui ?? createMockTui();
  const width = options.width ?? 80;
  const rendered: string[] = [];
  let resolved = false;
  const pending = Promise.withResolvers<T>();

  const done = (value: T) => {
    if (resolved) {
      return;
    }

    if (customOptions?.overlay === true) {
      tui.hideOverlay();
    }

    resolved = true;
    pending.resolve(value);
  };

  const component = await factory(tui, theme, keybindings, done);
  let handle = createOverlayHandle();
  const mounted = !resolved;

  if (mounted) {
    const configuredOverlayOptions = customOptions?.overlayOptions;

    const overlayOptions =
      typeof configuredOverlayOptions === "function"
        ? configuredOverlayOptions()
        : configuredOverlayOptions;

    handle =
      customOptions?.overlay === true
        ? tui.showOverlay(component, overlayOptions)
        : createOverlayHandle();
    customOptions?.onHandle?.(handle);
  }

  try {
    if (mounted) {
      await options.onComponent?.(component);

      if (
        options.captureRender === "before" ||
        options.captureRender === "before-and-after"
      ) {
        rendered.push(component.render(width).join("\n"));
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
        rendered.push(component.render(width).join("\n"));
      }

      await options.onAfterCapture?.();
    }

    const result = await pending.promise;

    return { component, handle, rendered, result };
  } finally {
    if (mounted) {
      component.dispose?.();
    }
  }
};

export const createCustomUiDriver = (options: CustomUiDriverOptions = {}) => {
  const rendered: string[] = [];
  let component: CustomUiComponent | undefined;
  let handle = createOverlayHandle();

  const custom: ExtensionUIContext["custom"] = async <TResult>(
    factory: CustomUiFactory<TResult>,
    customOptions?: CustomUiOptions
  ): Promise<TResult> => {
    const { onComponent } = options;

    const result = await runCustomUi(
      factory,
      {
        ...options,
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
      }
    );

    rendered.push(...result.rendered);

    return result.result;
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
