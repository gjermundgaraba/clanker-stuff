import type { RollingFont } from "./font.js";

export const ROLL_FRAME_MS = 1000 / 30;

const STEP_MS = 260;

const MAX_ROLL_MS = 900;

/** Format changes snap; only differing decimal digits may become font frames. */
export const canRoll = (before: string, text: string): boolean =>
  before !== text && before.replace(/\d/gu, "#") === text.replace(/\d/gu, "#");

/** Each wheel travels at one cell per step, accelerated only by the duration cap. */
export const digitTransition = (before: string, text: string, index: number, elapsed: number) => {
  const from = before[index];
  const to = text[index];

  if (from === to || from === undefined || to === undefined) return undefined;
  const direction = text > before ? 1 : -1;
  // The tens-of-seconds wheel wraps at six, not ten (1:59 → 2:00).
  const radix = text.includes(":") && index === text.length - 2 ? 6 : 10;
  const distance = ((Number(to) - Number(from)) * direction + radix) % radix;
  const duration = Math.min(distance * STEP_MS, MAX_ROLL_MS);

  if (elapsed >= duration) return undefined;
  const travel = (Math.max(0, elapsed) / duration) * distance;
  const steps = Math.floor(travel);
  const digit = (step: number) => String((Number(from) + direction * step + radix) % radix);

  return {
    before: digit(steps),
    after: digit(steps + 1),
    progress: travel - steps,
  };
};

interface CounterState {
  text: string;
  before: string;
  startedAt: number;
}

/** Font frames replace only marked numeric cells; all layout stays native text. */
export class RollingNumbers {
  readonly #counters = new Map<string, CounterState>();

  reset(): void {
    this.#counters.clear();
  }

  frame(
    now: number,
    font: RollingFont,
    render: (number: (id: string, text: string) => string) => string[],
  ): { lines: string[]; animated: boolean } {
    const requested = new Set<string>();
    let animated = false;

    const lines = render((id, text) => {
      requested.add(id);
      const previous = this.#counters.get(id);

      const state =
        !previous || previous.text !== text
          ? { text, before: previous?.text ?? text, startedAt: now }
          : previous;

      this.#counters.set(id, state);
      const elapsed = now - state.startedAt;

      if (!canRoll(state.before, text)) return text;

      return Array.from(text, (digit, index) => {
        const transition = digitTransition(state.before, text, index, elapsed);

        if (!transition) return digit;
        animated = true;

        return font.glyph(transition.before, transition.after, transition.progress);
      }).join("");
    });

    for (const id of this.#counters.keys()) {
      if (!requested.has(id)) this.#counters.delete(id);
    }

    return { lines, animated };
  }
}
