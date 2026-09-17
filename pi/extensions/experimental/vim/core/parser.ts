export interface Command {
  key: string;
  count: number;
  explicit: boolean;
  motion?: string;
  target?: string;
  around?: boolean;
}
export const MAX_COUNT = 1000;
const motions = "hjklwbeWBE0^$G%";
const standalone = "iIaAoOvVxXsSDCpPJu.~";
const objects = /^[ia][wW"'`(){}[\]<>]$/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const single = (text: string) => [...segmenter.segment(text)].length === 1;

/** A leading zero is the line-start motion, never a count. */
function counted(input: string): [digits: string, rest: string] {
  const [, digits = "", rest = ""] = /^(\d*)(.*)$/u.exec(input)!;
  return digits.startsWith("0") ? ["", digits + rest] : [digits, rest];
}
/** One grammar for bare moves, operator targets and Visual objects; undefined is invalid. */
function target(
  rest: string,
  object: boolean,
): Pick<Command, "motion" | "target" | "around"> | "pending" | undefined {
  if (object && (rest === "i" || rest === "a")) return "pending";
  if (object && objects.test(rest))
    return { motion: "object", target: rest[1], around: rest[0] === "a" };
  if (rest === "g" || (rest.length === 1 && "fFtT".includes(rest))) return "pending";
  if (rest === "gg" || (rest.length === 1 && motions.includes(rest))) return { motion: rest };
  if ("fFtT".includes(rest[0]!) && single(rest.slice(1)))
    return { motion: rest[0], target: rest.slice(1) };
  return undefined;
}

/** A bounded grammar, not a key replay queue. Invalid sequences consume no later command. */
export class Parser {
  private pending = "";
  reset() {
    this.pending = "";
  }
  feed(key: string, visual = false): Command | undefined {
    if (this.pending.length > 16) this.reset();
    this.pending += key;
    const [digits, rest] = counted(this.pending);
    if (!rest) return undefined;
    let base = { count: Math.min(MAX_COUNT, Number(digits) || 1), explicit: digits !== "" };
    let command: string | undefined;
    let tail = rest;
    const first = rest[0]!;
    if ("dcy".includes(first)) {
      if (visual) return this.done({ ...base, key: first });
      const [extra, after] = counted(rest.slice(1));
      if (!after) return undefined;
      // Counts before the operator and before its motion multiply; either makes the count explicit.
      base = {
        count: Math.min(MAX_COUNT, base.count * (Number(extra) || 1)),
        explicit: base.explicit || extra !== "",
      };
      if (after === first) return this.done({ ...base, key: first, motion: "line" });
      command = first;
      tail = after;
    } else if (visual && (first === "i" || first === "a")) command = "select";
    else if (rest === "r") return undefined;
    else if (first === "r" && single(rest.slice(1)))
      return this.done({ ...base, key: "r", target: rest.slice(1) });
    const found = target(tail, command !== undefined);
    if (found === "pending") return undefined;
    if (found) return this.done({ ...base, key: command ?? "move", ...found });
    if (!command && rest.length === 1 && standalone.includes(rest))
      return this.done({ ...base, key: rest });
    return this.done();
  }
  private done(command?: Command) {
    this.reset();
    return command;
  }
}
