import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";

import { phaseOf } from "./machine.js";
import type { Phase, WaitSnapshot } from "./machine.js";

export interface WaitSummary {
  readonly id: string;
  readonly label: string;
  readonly phase: Phase;
  readonly attempts: number;
  readonly lastExitCode: number | null | undefined;
  readonly openedAt: string;
  readonly endedAt?: string;
}

export const summaryOf = (snapshot: WaitSnapshot): WaitSummary => {
  const { context } = snapshot;

  return {
    id: context.id,
    label: context.spec.label,
    phase: phaseOf(snapshot),
    attempts: context.attempts,
    lastExitCode: context.lastCheck?.exitCode,
    openedAt: new Date(context.openedAt).toISOString(),
    ...(context.endedAt === undefined
      ? {}
      : { endedAt: new Date(context.endedAt).toISOString() }),
  };
};

export const rowOf = (summary: WaitSummary): string =>
  [
    summary.phase,
    `${summary.attempts} ${summary.attempts === 1 ? "check" : "checks"}`,
    inlineText(summary.label),
    summary.id,
  ].join(" · ");

/** The model-facing wake for waits whose condition passed. */
export const wakeText = (snapshots: readonly WaitSnapshot[]): string =>
  [
    ...snapshots.flatMap(({ context }) => [
      `Wait ${context.id} (${inlineText(context.spec.label)}) is satisfied: its condition exited 0 on check ${context.attempts}.`,
      `Your instruction for it: ${context.spec.instruction}`,
      "",
    ]),
    "This wake is sent once. The condition held when it was checked; confirm the state before acting, and act on each result once.",
  ].join("\n");
