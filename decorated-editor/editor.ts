import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";

export const REGISTER_DECORATION_EVENT = "decorated-editor:register";

type DecorationColor = Parameters<Theme["fg"]>[0];
interface Decoration {
  color: DecorationColor;
  id: string;
  pattern: RegExp;
}

const isDecoration = (data: unknown): data is Decoration => {
  if (typeof data !== "object" || data === null) {
    return false;
  }

  const candidate = data as Partial<Decoration>;
  return (
    typeof candidate.color === "string" &&
    typeof candidate.id === "string" &&
    candidate.pattern instanceof RegExp
  );
};

const decorateEditor = (
  base: EditorComponent,
  decorations: Map<string, Decoration>,
  getTheme: () => Theme
): EditorComponent =>
  new Proxy(base, {
    get(target, property) {
      if (property === "render") {
        return (width: number) => {
          const theme = getTheme();
          return target.render(width).map((line) => {
            let decorated = line;
            for (const decoration of decorations.values()) {
              decoration.pattern.lastIndex = 0;
              decorated = decorated.replace(decoration.pattern, (match) =>
                theme.fg(decoration.color, match)
              );
            }
            return decorated;
          });
        };
      }

      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function"
        ? (...args: unknown[]) => Reflect.apply(value, target, args) as unknown
        : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  });

export const createDecoratedEditor = () => {
  const decorations = new Map<string, Decoration>();

  return {
    install(ctx: ExtensionContext): void {
      const previous = ctx.ui.getEditorComponent();
      ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
        decorateEditor(
          previous?.(tui, editorTheme, keybindings) ??
            new CustomEditor(tui, editorTheme, keybindings),
          decorations,
          () => ctx.ui.theme
        )
      );
    },
    register(data: unknown): void {
      if (isDecoration(data)) {
        decorations.set(data.id, data);
      }
    },
  };
};
