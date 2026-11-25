import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import { Type } from "typebox";
import type { Static } from "typebox";

import type { LastResult, WaitSnapshot } from "./machine.js";

const lastCheck = (result: LastResult | undefined): string => {
  if (result === undefined) {
    return "not checked yet";
  }

  if (result === "timeout") {
    return "last check timed out";
  }

  if (result === "error") {
    return "last check could not run";
  }

  return `last check exited ${result}`;
};

const stateSchema = Type.Union([
  Type.Literal("open"),
  Type.Literal("satisfied"),
  Type.Literal("expired"),
  Type.Literal("cancelled"),
]);

export const rowSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  state: stateSchema,
  lastCheck: Type.String(),
});

export type WaitRow = Static<typeof rowSchema>;

export const toolDetailsSchema = Type.Object({ rows: Type.Array(rowSchema) });

export type ToolDetails = Static<typeof toolDetailsSchema>;

const stateOf = (snapshot: WaitSnapshot): WaitRow["state"] => {
  if (snapshot.status === "active") {
    return "open";
  }

  return snapshot.matches("satisfied") ? "satisfied" : "expired";
};

export const rowOf = (snapshot: WaitSnapshot): WaitRow => ({
  id: snapshot.context.id,
  label: snapshot.context.spec.label,
  state: stateOf(snapshot),
  lastCheck: lastCheck(snapshot.context.lastResult),
});

export const rowText = (row: WaitRow): string =>
  [row.state, row.lastCheck, inlineText(row.label), row.id].join(" · ");

export const wakeDetailsSchema = Type.Object({
  waits: Type.Array(
    Type.Object({
      id: Type.String(),
      label: Type.String(),
      outcome: Type.Union([Type.Literal("satisfied"), Type.Literal("expired")]),
      lastCheck: Type.String(),
      instruction: Type.String(),
    })
  ),
});

export type WakeDetails = Static<typeof wakeDetailsSchema>;

export const wakeDetails = (
  snapshots: readonly WaitSnapshot[]
): WakeDetails => ({
  waits: snapshots.map((snapshot) => ({
    id: snapshot.context.id,
    label: snapshot.context.spec.label,
    outcome: snapshot.matches("satisfied") ? "satisfied" : "expired",
    lastCheck: lastCheck(snapshot.context.lastResult),
    instruction: snapshot.context.spec.instruction,
  })),
});

const wakeLines = (snapshot: WaitSnapshot): string[] => {
  const { context } = snapshot;
  const name = `Wait ${context.id} (${inlineText(context.spec.label)})`;

  return snapshot.matches("satisfied")
    ? [
        `${name} is satisfied: its condition exited 0.`,
        `Your instruction for it: ${context.spec.instruction}`,
      ]
    : [
        `${name} expired before its condition exited 0 (${lastCheck(context.lastResult)}).`,
        `It was waiting so that you could: ${context.spec.instruction}`,
        "Do not follow that instruction unless you confirm the condition holds now.",
      ];
};

export const wakeText = (snapshots: readonly WaitSnapshot[]): string =>
  [
    ...snapshots.flatMap((snapshot) => [...wakeLines(snapshot), ""]),
    "Each wait wakes you once. A condition held when it was checked; confirm the state before acting, and act on each result once.",
  ].join("\n");
