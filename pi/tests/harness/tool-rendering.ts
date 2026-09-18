import type { TUnsafe } from "typebox";
import { stripVTControlCharacters } from "node:util";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

// Fixtures start with empty argument/state objects, not Pi's unchecked generic defaults.
type Context = Omit<
  Parameters<NonNullable<ToolDefinition<TUnsafe<unknown>, unknown, unknown>["renderCall"]>>[2],
  "args" | "state"
>;

export const toolRenderContext = (overrides: Partial<Context> = {}) => ({
  args: {},
  argsComplete: true,
  cwd: "/tmp",
  executionStarted: true,
  expanded: false,
  invalidate() {},
  isError: false,
  isPartial: false,
  lastComponent: undefined,
  showImages: false,
  state: {},
  toolCallId: "synthetic",
  ...overrides,
});

export const renderedRows = (component: Component, width = 80) =>
  component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());

export const jsonToolResult = (value: JsonValue) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: undefined,
});
