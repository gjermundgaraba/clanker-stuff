export type TransportMode = "fallback" | "sse" | "websocket";

export type ParentScenarioKind =
  | "standard"
  | "branch"
  | "capabilities"
  | "portable"
  | "real-window"
  | "mid-turn"
  | "soak"
  | "stream-fault"
  | "threshold";

export type ChildScenarioKind = "branch-child" | "restart-child";

interface ParentInvocationBase {
  readonly process: "parent";
  readonly rounds: number;
  readonly showHelp: boolean;
  readonly transport: TransportMode;
}

export type ParentInvocation = {
  readonly [Kind in ParentScenarioKind]: ParentInvocationBase & {
    readonly kind: Kind;
  };
}[ParentScenarioKind];

interface ChildInvocationBase {
  readonly process: "child";
  readonly transport: TransportMode;
}

export type ChildInvocation = {
  readonly [Kind in ChildScenarioKind]: ChildInvocationBase & {
    readonly kind: Kind;
  };
}[ChildScenarioKind];

export type LiveInvocation = ParentInvocation | ChildInvocation;

const PARENT_FLAGS = [
  ["--branch", "branch"],
  ["--capabilities", "capabilities"],
  ["--portable", "portable"],
  ["--real-window", "real-window"],
  ["--mid-turn", "mid-turn"],
  ["--soak", "soak"],
  ["--stream-fault", "stream-fault"],
  ["--threshold", "threshold"],
] as const satisfies readonly (readonly [string, ParentScenarioKind])[];

const CHILD_FLAGS = [
  ["--branch-child", "branch-child"],
  ["--restart-child", "restart-child"],
] as const satisfies readonly (readonly [string, ChildScenarioKind])[];

const TRANSPORT_FLAGS = [
  ["--fallback", "fallback"],
  ["--sse", "sse"],
  ["--websocket", "websocket"],
] as const satisfies readonly (readonly [string, TransportMode])[];

const assertOption: (
  condition: boolean,
  message: string
) => asserts condition = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const selected = <Value extends string>(
  args: readonly string[],
  choices: readonly (readonly [string, Value])[]
): Value[] =>
  choices.flatMap(([flag, value]) => (args.includes(flag) ? [value] : []));

const DEFAULT_ROUNDS: Readonly<Record<ParentScenarioKind, number>> = {
  branch: 2,
  capabilities: 3,
  "mid-turn": 2,
  portable: 3,
  "real-window": 2,
  soak: 10,
  standard: 3,
  "stream-fault": 2,
  threshold: 3,
};

const allowsOneRound = (kind: ParentScenarioKind): boolean =>
  kind === "capabilities" || kind === "portable" || kind === "threshold";

const positiveInteger = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number
): number => {
  const raw = environment[name];
  const value = raw === undefined ? fallback : Number(raw);
  assertOption(
    Number.isSafeInteger(value) && value > 0,
    `${name} must be a positive safe integer`
  );
  return value;
};

export const parseTransport = (value: string): TransportMode => {
  assertOption(
    value === "fallback" || value === "sse" || value === "websocket",
    `Unknown transport mode: ${value}`
  );
  return value;
};

const parseParentTransport = (args: readonly string[]): TransportMode => {
  const transports = selected(args, TRANSPORT_FLAGS);
  assertOption(
    transports.length <= 1,
    "Choose only one transport: --sse, --websocket, or --fallback"
  );
  return transports[0] ?? "sse";
};

const assertTransportAllowed = (
  kind: ParentScenarioKind,
  transport: TransportMode
) => {
  assertOption(
    kind !== "portable" || transport === "sse",
    "Portable canary requires SSE request inspection"
  );
  assertOption(
    (kind !== "real-window" && kind !== "mid-turn") ||
      transport !== "websocket",
    "Real-window and mid-turn canaries require SSE request inspection"
  );
  assertOption(
    kind !== "stream-fault" || transport === "sse",
    "Stream-fault canary requires SSE"
  );
};

const childTransportEnvironmentName = (kind: ChildScenarioKind): string =>
  kind === "branch-child"
    ? "CODEX_COMPACTION_BRANCH_TRANSPORT"
    : "CODEX_COMPACTION_RESTART_TRANSPORT";

export const parseLiveInvocation = (
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): LiveInvocation => {
  const transport = parseParentTransport(args);
  const parentKinds = selected(args, PARENT_FLAGS);
  const childKinds = selected(args, CHILD_FLAGS);
  assertOption(
    parentKinds.length <= 1,
    "Choose only one behavior mode: --branch, --capabilities, --portable, --real-window, --mid-turn, --soak, --stream-fault, or --threshold"
  );
  assertOption(
    childKinds.length <= 1,
    "Choose only one child mode: --branch-child or --restart-child"
  );
  assertOption(
    parentKinds.length === 0 || childKinds.length === 0,
    "Parent behavior modes cannot be combined with child modes"
  );

  const [childKind] = childKinds;
  if (childKind !== undefined) {
    const transportName = childTransportEnvironmentName(childKind);
    const childTransport = environment[transportName];
    assertOption(
      typeof childTransport === "string" && childTransport.length > 0,
      `${transportName} is required`
    );
    return {
      kind: childKind,
      process: "child",
      transport: parseTransport(childTransport),
    };
  }

  const kind = parentKinds[0] ?? "standard";
  assertTransportAllowed(kind, transport);
  const rounds = args.includes("--help")
    ? DEFAULT_ROUNDS[kind]
    : positiveInteger(
        environment,
        "CODEX_COMPACTION_LIVE_ROUNDS",
        DEFAULT_ROUNDS[kind]
      );
  assertOption(
    allowsOneRound(kind) || rounds >= 2,
    "Live canary requires at least 2 compactions"
  );
  return {
    kind,
    process: "parent",
    rounds,
    showHelp: args.includes("--help"),
    transport,
  };
};

export const usesRealWindow = (kind: ParentScenarioKind): boolean =>
  kind === "real-window" || kind === "mid-turn";
