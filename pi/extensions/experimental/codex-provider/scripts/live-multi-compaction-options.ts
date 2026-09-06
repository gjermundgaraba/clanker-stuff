import { parseArgs } from "node:util";

export type TransportMode = "fallback" | "sse" | "websocket";

export type ParentScenarioKind =
  | "standard"
  | "branch"
  | "capabilities"
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
  "branch",
  "capabilities",
  "real-window",
  "mid-turn",
  "soak",
  "stream-fault",
  "threshold",
] as const satisfies readonly ParentScenarioKind[];

const CHILD_FLAGS = [
  "branch-child",
  "restart-child",
] as const satisfies readonly ChildScenarioKind[];

const TRANSPORT_FLAGS = [
  "fallback",
  "sse",
  "websocket",
] as const satisfies readonly TransportMode[];

const OPTIONS = Object.fromEntries(
  [...PARENT_FLAGS, ...CHILD_FLAGS, ...TRANSPORT_FLAGS, "help"].map((flag) => [
    flag,
    { type: "boolean" as const },
  ]),
);

const assertOption: (condition: boolean, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) {
    throw new Error(message);
  }
};

const selected = <Value extends string>(
  values: Readonly<Record<string, boolean | undefined>>,
  choices: readonly Value[],
): Value[] => choices.filter((flag) => values[flag] === true);

const DEFAULT_ROUNDS = {
  branch: 2,
  capabilities: 3,
  "mid-turn": 2,
  "real-window": 2,
  soak: 10,
  standard: 3,
  "stream-fault": 2,
  threshold: 3,
} as const satisfies Readonly<Record<ParentScenarioKind, number>>;

const allowsOneRound = (kind: ParentScenarioKind): boolean =>
  kind === "capabilities" || kind === "threshold";

const positiveInteger = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number => {
  const raw = environment[name];
  const value = raw === undefined ? fallback : Number(raw);
  assertOption(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer`);
  return value;
};

export const parseTransport = (value: string): TransportMode => {
  assertOption(
    value === "fallback" || value === "sse" || value === "websocket",
    `Unknown transport mode: ${value}`,
  );
  return value;
};

const parseParentTransport = (
  values: Readonly<Record<string, boolean | undefined>>,
): TransportMode => {
  const transports = selected(values, TRANSPORT_FLAGS);
  assertOption(
    transports.length <= 1,
    "Choose only one transport: --sse, --websocket, or --fallback",
  );
  return transports[0] ?? "sse";
};

const assertTransportAllowed = (kind: ParentScenarioKind, transport: TransportMode) => {
  assertOption(
    (kind !== "real-window" && kind !== "mid-turn") || transport !== "websocket",
    "Real-window and mid-turn canaries require SSE request inspection",
  );
  assertOption(kind !== "stream-fault" || transport === "sse", "Stream-fault canary requires SSE");
};

const childTransportEnvironmentName = (kind: ChildScenarioKind): string =>
  kind === "branch-child"
    ? "CODEX_COMPACTION_BRANCH_TRANSPORT"
    : "CODEX_COMPACTION_RESTART_TRANSPORT";

export const parseLiveInvocation = (
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): LiveInvocation => {
  const { tokens, values } = parseArgs({
    allowPositionals: false,
    args: [...args],
    options: OPTIONS,
    strict: true,
    tokens: true,
  });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind === "option") {
      assertOption(!seen.has(token.name), `Option --${token.name} may only be specified once`);
      seen.add(token.name);
    }
  }
  const transport = parseParentTransport(values);
  const parentKinds = selected(values, PARENT_FLAGS);
  const childKinds = selected(values, CHILD_FLAGS);
  assertOption(
    parentKinds.length <= 1,
    "Choose only one behavior mode: --branch, --capabilities, --real-window, --mid-turn, --soak, --stream-fault, or --threshold",
  );
  assertOption(
    childKinds.length <= 1,
    "Choose only one child mode: --branch-child or --restart-child",
  );
  assertOption(
    parentKinds.length === 0 || childKinds.length === 0,
    "Parent behavior modes cannot be combined with child modes",
  );

  const [childKind] = childKinds;
  if (childKind !== undefined) {
    const transportName = childTransportEnvironmentName(childKind);
    const childTransport = environment[transportName];
    assertOption(
      childTransport !== undefined && childTransport.length > 0,
      `${transportName} is required`,
    );
    return {
      kind: childKind,
      process: "child",
      transport: parseTransport(childTransport),
    };
  }

  const kind = parentKinds[0] ?? "standard";
  assertTransportAllowed(kind, transport);
  const rounds = values.help
    ? DEFAULT_ROUNDS[kind]
    : positiveInteger(environment, "CODEX_COMPACTION_LIVE_ROUNDS", DEFAULT_ROUNDS[kind]);
  assertOption(allowsOneRound(kind) || rounds >= 2, "Live canary requires at least 2 compactions");
  return {
    kind,
    process: "parent",
    rounds,
    showHelp: values.help === true,
    transport,
  };
};

export const usesRealWindow = (kind: ParentScenarioKind): boolean =>
  kind === "real-window" || kind === "mid-turn";
