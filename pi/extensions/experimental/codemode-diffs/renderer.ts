import { preview } from "@clanker-stuff/pi-tool-rendering/preview";
import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import type { ToolDefinition, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { TUnsafe } from "typebox";
import { Value } from "typebox/value";

import { renderHighlightedDiff } from "./diff.js";
import { DiffDetailsSchema } from "./diffs.js";

type ResultRenderer = NonNullable<
  ToolDefinition<TUnsafe<unknown>, unknown, unknown>["renderResult"]
>;

class DiffResult extends Container {
  original: Component | undefined;
}

export function resolveRenderer(
  name: string,
  next: () => ToolRenderers | undefined,
): ToolRenderers | undefined {
  const base = next();
  const renderOriginal = base?.renderResult;

  if (name !== "codemode" || !renderOriginal) return base;

  const renderResult: ResultRenderer = (result, options, theme, context) => {
    const component =
      context.lastComponent instanceof DiffResult ? context.lastComponent : new DiffResult();

    component.clear();
    component.original = renderOriginal(result, options, theme, {
      ...context,
      lastComponent: component.original,
    });
    component.addChild(component.original);

    if (
      !options.isPartial &&
      Value.Check(DiffDetailsSchema, result.details) &&
      result.details.codemodeDiffs.length
    ) {
      const edits = result.details.codemodeDiffs;
      component.addChild(new Spacer(1));
      component.addChild(
        preview(
          () => {
            const body = new Container();
            body.addChild(new Text(theme.bold(`Edits (${edits.length})`), 0, 0));

            for (const edit of edits) {
              body.addChild(new Spacer(1));
              body.addChild(new Text(theme.bold(inlineText(edit.path)), 0, 0));
              body.addChild(new Text(renderHighlightedDiff(edit.diff, edit.syntax, theme), 0, 0));
            }

            return body;
          },
          options.expanded,
          12,
        ),
      );
    }

    return component;
  };

  return { ...base, renderResult };
}
