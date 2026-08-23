import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const CODEX_COMMIT = "12933b69551394328319dcdd1bcee7907326dc85";
const CONFIG_PATH = "codex-rs/core/src/config/mod.rs";
const PLAN_PATH = "codex-rs/core/src/tools/spec_plan.rs";
const SPEC_PATH = "codex-rs/core/src/tools/handlers/multi_agents_spec.rs";
const CATALOG_PATH = "codex-rs/models-manager/models.json";
const fixturePath = path.resolve(
  import.meta.dirname,
  "../docs/fixtures/codex-contract.generated.ts"
);
const checkout =
  process.env.CODEX_CHECKOUT ??
  path.join(homedir(), ".cache/checkouts/github.com/openai/codex");

const [mode, ...extraArguments] = process.argv.slice(2);
if ((mode !== "--check" && mode !== "--write") || extraArguments.length !== 0) {
  throw new Error("Usage: extract-codex-contracts.ts --check|--write");
}

const source = (sourcePath: string): string =>
  execFileSync("git", ["show", `${CODEX_COMMIT}:${sourcePath}`], {
    cwd: checkout,
    encoding: "utf-8",
  });

const configSource = source(CONFIG_PATH);
const planSource = source(PLAN_PATH);
const specSource = source(SPEC_PATH);

const functionBody = (
  input: string,
  name: string,
  sourcePath = SPEC_PATH
): string => {
  const match = new RegExp(`(?:pub )?fn ${name}\\b`, "u").exec(input);
  if (match === null) {
    throw new Error(`Expected function ${name} in ${sourcePath}`);
  }
  const start = input.indexOf("{", match.index);
  let depth = 0;
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === "{") {
      depth += 1;
    } else if (input[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start + 1, index);
      }
    }
  }
  throw new Error(`Unterminated function ${name} in ${sourcePath}`);
};

const stringConstant = (input: string, name: string): string => {
  const value = new RegExp(
    `(?:pub )?const ${name}: &str = "(?<value>[^"]+)";`,
    "u"
  ).exec(input)?.groups?.value;
  if (value === undefined) {
    throw new Error(`Expected string constant ${name}`);
  }
  return value;
};

const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].toSorted();
const propertyKeys = (body: string): string[] =>
  [...body.matchAll(/"(?<key>[a-z][a-z0-9_]*)"\.to_string\(\),/gu)].flatMap(
    (match) => (match.groups?.key === undefined ? [] : [match.groups.key])
  );
const requiredPropertySets = (body: string): string[][] =>
  [...body.matchAll(/"required": \[(?<properties>[^\]]+)\]/gu)].map((match) =>
    [
      ...(match.groups?.properties ?? "").matchAll(/"(?<key>[a-z_]+)"/gu),
    ].flatMap((property) =>
      property.groups?.key === undefined ? [] : [property.groups.key]
    )
  );
const without = (
  values: readonly string[],
  excluded: readonly string[]
): string[] => values.filter((value) => !excluded.includes(value));

const toolFactories = [
  ...specSource.matchAll(
    /pub fn (?<factory>create_[a-z0-9_]+)\([^)]*\) -> ToolSpec \{/gu
  ),
].map((match) => {
  const factory = match.groups?.factory;
  if (factory === undefined) {
    throw new Error("Expected collaboration tool factory name");
  }
  const body = functionBody(specSource, factory);
  const name = /name: "(?<name>[a-z_]+)"\.to_string\(\),/u.exec(body)?.groups
    ?.name;
  if (name === undefined) {
    throw new Error(`Expected a tool name in ${factory}`);
  }
  return {
    name,
    protocol: body.includes("MULTI_AGENT_V1_NAMESPACE") ? "v1" : "v2",
  } as const;
});

const namespaceMerge = functionBody(
  planSource,
  "merge_into_namespaces",
  PLAN_PATH
);
if (
  !namespaceMerge.includes("namespace.tools.sort_by") ||
  !namespaceMerge.includes("left_name.cmp(right_name)")
) {
  throw new Error(`Expected name-ascending namespace members in ${PLAN_PATH}`);
}

const v1Tools = sortedUnique(
  toolFactories
    .filter(({ protocol }) => protocol === "v1")
    .map(({ name }) => name)
);
const v2Tools = sortedUnique(
  toolFactories
    .filter(({ protocol }) => protocol === "v2")
    .map(({ name }) => name)
);

const allV2SpawnProperties = sortedUnique([
  ...propertyKeys(functionBody(specSource, "spawn_agent_common_properties_v2")),
  "task_name",
]);
const defaultBoolean = (name: string): boolean => {
  const value = new RegExp(`${name}: (?<value>true|false)`, "u").exec(
    configSource
  )?.groups?.value;
  if (value === undefined) {
    throw new Error(`Expected default configuration field ${name}`);
  }
  return value === "true";
};
const hideSpawnMetadata = defaultBoolean("hide_spawn_agent_metadata");
const exposeModelOverrides = defaultBoolean(
  "expose_spawn_agent_model_overrides"
);
const stockV2SpawnProperties = without(allV2SpawnProperties, [
  "agent_type",
  "service_tier",
  ...(exposeModelOverrides ? [] : ["model", "reasoning_effort"]),
]);
const [hiddenSpawnOutput, visibleSpawnOutput] = requiredPropertySets(
  functionBody(specSource, "spawn_agent_output_schema_v2")
);
if (hiddenSpawnOutput === undefined || visibleSpawnOutput === undefined) {
  throw new Error(`Expected both V2 spawn output profiles in ${SPEC_PATH}`);
}
const stockV2SpawnOutputProperties = (
  hideSpawnMetadata ? hiddenSpawnOutput : visibleSpawnOutput
).toSorted();

interface CatalogModel {
  multi_agent_version?: string | null;
  slug?: string;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCatalogModel = (value: unknown): value is CatalogModel =>
  isRecord(value) &&
  (value.slug === undefined || typeof value.slug === "string") &&
  (value.multi_agent_version === undefined ||
    value.multi_agent_version === null ||
    typeof value.multi_agent_version === "string");
const parsedCatalog: unknown = JSON.parse(source(CATALOG_PATH));
if (
  !isRecord(parsedCatalog) ||
  !Array.isArray(parsedCatalog.models) ||
  !parsedCatalog.models.every(isCatalogModel)
) {
  throw new TypeError(`Expected models in ${CATALOG_PATH}`);
}
const catalog = { models: parsedCatalog.models };
const catalogVersion = (slug: string): string | null | undefined =>
  catalog.models.find((model) => model.slug === slug)?.multi_agent_version;

const fixture = {
  catalog: {
    declarations: {
      "gpt-5.6-luna": catalogVersion("gpt-5.6-luna"),
      "gpt-5.6-sol": catalogVersion("gpt-5.6-sol"),
      "gpt-5.6-terra": catalogVersion("gpt-5.6-terra"),
    },
  },
  commit: CODEX_COMMIT,
  sources: [CATALOG_PATH, CONFIG_PATH, PLAN_PATH, SPEC_PATH],
  v1: {
    namespace: stringConstant(specSource, "MULTI_AGENT_V1_NAMESPACE"),
    tools: v1Tools,
  },
  v2: {
    namespace: stringConstant(
      configSource,
      "DEFAULT_MULTI_AGENT_V2_TOOL_NAMESPACE"
    ),
    stockSpawnOutputProperties: stockV2SpawnOutputProperties,
    stockSpawnProperties: stockV2SpawnProperties,
    tools: v2Tools,
  },
};
const rendered = `// Generated by scripts/extract-codex-contracts.ts. Do not edit.
export const codexContractFixture = ${JSON.stringify(fixture, null, 2)} as const;
`;

if (mode === "--write") {
  await writeFile(fixturePath, rendered);
} else {
  const existing = await readFile(fixturePath, "utf-8");
  if (existing !== rendered) {
    throw new Error(
      "Codex contract fixture is stale; rerun extractor with --write"
    );
  }
}
