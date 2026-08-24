import { FOOTER_PROTOCOL_VERSION } from "@clanker-stuff/footer-protocol";
import type { FooterContent } from "@clanker-stuff/footer-protocol";
import { visibleWidth } from "@earendil-works/pi-tui";

import { hasTerminalControl } from "./config.js";
import type { FooterConfig } from "./config.js";
import type { HostRuntime } from "./host.js";
import { sanitizeNativeStatus } from "./layout.js";
import { summary } from "./summary.js";
import type { FooterEditorWidget } from "./ui.js";
import type { LiveWidget } from "./widgets.js";

const duplicatePlacements = (config: FooterConfig): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of config.rows) {
    for (const group of ["left", "center", "right"] as const) {
      for (const id of row[group]) {
        if (seen.has(id)) {
          duplicates.add(id);
        }
        seen.add(id);
      }
    }
  }
  return [...duplicates];
};

export const editorWidgets = (runtime: HostRuntime): FooterEditorWidget[] => {
  const widgets: FooterEditorWidget[] = [
    ...runtime.builtins.values(),
    ...runtime.rich.values(),
  ].map((widget) => ({
    defaultEnabled: widget.snapshot.defaults?.enabled,
    id: widget.snapshot.id,
    label: widget.snapshot.label,
    source: widget.source,
  }));
  for (const [key, value] of runtime.footerData?.getExtensionStatuses() ?? []) {
    if (!hasTerminalControl(key) && visibleWidth(sanitizeNativeStatus(value)) > 0) {
      widgets.push({
        id: `status:${key}`,
        label: key,
        source: "native",
      });
    }
  }
  widgets.push(
    {
      id: "footer.widgets",
      label: "Rich widgets",
      source: "builtin",
    },
    {
      id: "footer.statuses",
      label: "Native statuses",
      source: "builtin",
    },
  );
  return widgets.toSorted((left, right) => left.id.localeCompare(right.id));
};

const placementFor = (runtime: HostRuntime, id: string): string => {
  for (const [rowIndex, row] of runtime.config.rows.entries()) {
    for (const group of ["left", "center", "right"] as const) {
      const index = row[group].indexOf(id);
      if (index !== -1) {
        return `row ${rowIndex + 1} ${group} #${index + 1}`;
      }
    }
  }
  return "aggregate or unavailable";
};

const plainContent = (content: FooterContent): string => content.map((span) => span.text).join("");

const healthAge = (updatedAt: number | undefined, timestamp: number): string =>
  updatedAt === undefined
    ? "unknown"
    : `${Math.max(0, Math.round((timestamp - updatedAt) / 1000))}s`;

const healthLines = (widget: LiveWidget, timestamp: number): string[] => [
  `  health: ${widget.snapshot.health?.state ?? "none"} · age ${healthAge(widget.snapshot.health?.updatedAt, timestamp)}`,
  ...(widget.snapshot.health?.message === undefined
    ? []
    : [`  health detail: ${summary(widget.snapshot.health.message)}`]),
];

export const inspectLines = (runtime: HostRuntime, timestamp: number): string[] => {
  const byDecision = new Map(
    runtime.lastLayout?.decisions.map((decision) => [
      decision.id,
      `${decision.outcome}: ${decision.reason}`,
    ]),
  );
  const lines =
    runtime.lastLayout?.duplicates.map((id) => `duplicate placement: ${summary(id)}`) ?? [];
  for (const widget of [...runtime.builtins.values(), ...runtime.rich.values()].toSorted(
    (left, right) => left.snapshot.id.localeCompare(right.snapshot.id),
  )) {
    const { content } = widget.snapshot;
    lines.push(
      `${summary(widget.snapshot.id)} [${widget.source}]`,
      `  content: ${plainContent(content)}`,
      ...healthLines(widget, timestamp),
      `  producer defaults: ${JSON.stringify(widget.snapshot.defaults ?? {})}`,
      `  user override: ${JSON.stringify(runtime.config.widgets[widget.snapshot.id] ?? {})}`,
      `  placement: ${placementFor(runtime, widget.snapshot.id)}`,
      `  layout: ${byDecision.get(widget.snapshot.id) ?? "not rendered"}`,
    );
  }
  for (const [key, value] of runtime.footerData?.getExtensionStatuses() ?? []) {
    const id = `status:${key}`;
    const consumers = [...runtime.rich.values()]
      .filter((widget) => widget.snapshot.consumesStatusKeys?.includes(key) === true)
      .map((widget) => widget.snapshot.id)
      .toSorted();
    const layout =
      byDecision.get(id) ??
      (runtime.lastLayout?.consumedStatusIds.includes(id) === true
        ? `consumed by ${consumers.join(", ") || "rich widget"}`
        : "not rendered");
    lines.push(
      `${summary(id)} [native]`,
      `  content: ${sanitizeNativeStatus(value)}`,
      `  user override: ${JSON.stringify(runtime.config.widgets[id] ?? {})}`,
      `  placement: ${placementFor(runtime, id)}`,
      `  layout: ${summary(layout)}`,
    );
  }
  return lines.length === 0 ? ["No live widgets."] : lines;
};

export const doctorLines = (runtime: HostRuntime, configPath: string): string[] => {
  const duplicates = duplicatePlacements(runtime.config);
  const lines = [
    `ownership: ${runtime.lifecycle}`,
    `protocol: v${FOOTER_PROTOCOL_VERSION}`,
    `instance: ${summary(runtime.instanceId)}`,
    `config: ${summary(configPath)}`,
    `rich widgets: ${[...runtime.rich.keys()].toSorted().map(summary).join(", ") || "none"}`,
    `duplicate placements: ${duplicates.map(summary).join(", ") || "none"}`,
  ];
  if (runtime.configLoaded.error !== undefined && runtime.configLoaded.error.length > 0) {
    lines.push(`config error: ${summary(runtime.configLoaded.error)}`);
  }
  lines.push(
    ...(runtime.collectorErrors.length === 0
      ? ["collector errors: none"]
      : runtime.collectorErrors.map((error) => `collector error: ${error}`)),
    ...(runtime.protocolErrors.length === 0
      ? ["protocol errors: none"]
      : runtime.protocolErrors.map(
          (error) => `${new Date(error.timestamp).toISOString()} ${error.class}: ${error.message}`,
        )),
  );
  return lines;
};
