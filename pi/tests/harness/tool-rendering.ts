import { stripVTControlCharacters } from "node:util";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

type Context = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
export const toolRenderContext = (overrides: Partial<Context> = {}): Context => ({
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
export const jsonToolResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: undefined,
});
