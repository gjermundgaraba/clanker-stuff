import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";

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

const stateOf = (snapshot: WaitSnapshot): string => {
  if (snapshot.status === "active") {
    return "open";
  }

  return snapshot.matches("satisfied") ? "satisfied" : "expired";
};

export const rowOf = (snapshot: WaitSnapshot): string =>
  [
    stateOf(snapshot),
    lastCheck(snapshot.context.lastResult),
    inlineText(snapshot.context.spec.label),
    snapshot.context.id,
  ].join(" · ");

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

/** The model-facing wake for finished waits. */
export const wakeText = (snapshots: readonly WaitSnapshot[]): string =>
  [
    ...snapshots.flatMap((snapshot) => [...wakeLines(snapshot), ""]),
    "Each wait wakes you once. A condition held when it was checked; confirm the state before acting, and act on each result once.",
  ].join("\n");
