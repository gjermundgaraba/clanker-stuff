import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { readWorkspacePackages } from "./workspace-packages.ts";

const CODE_FENCE = "```";
const MAX_README_LINES = 30;
const PACKAGE_TAIL_PATTERN =
  /^(?<usage>[\s\S]+?)(?:\n\n## (?<optionalSection>Requirements|Configuration)\n\n(?<optionalBody>[\s\S]+))?$/u;
const MARKDOWN_BLOCK_START = /^(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|>\s?|`{3}|~{3}|\|| {4}|\t)/u;
const PLUGIN_CATALOGS = [
  { directory: "claude/plugins", heading: "Claude Code plugins" },
  { directory: "codex/plugins", heading: "Codex plugins" },
];
const EXPERIMENTAL_NOTICE =
  "Experimental extensions are private, not stable daily drivers; they may change incompatibly or be deleted without notice.";
const CATALOG_ROW_PATTERN =
  /^\|\s*\[`(?<name>[^`]+)`\]\((?<target>[^)]+)\)\s*\|\s*(?<description>.*?)\s*\|$/gmu;

const repoRoot = process.cwd();
const extensionPackages = readWorkspacePackages()
  .filter(
    ({ packageJson }) =>
      Array.isArray(packageJson.pi?.extensions) && packageJson.pi.extensions.length > 0,
  )
  .toSorted((left, right) => left.dir.localeCompare(right.dir));
const packages = extensionPackages.filter(({ packageJson }) => packageJson.private === false);
const experimentalPackages = extensionPackages.filter(({ dir }) =>
  dir.startsWith("pi/extensions/experimental/"),
);
const errors: string[] = [];

const countPhysicalLines = (text: string) => {
  const withoutFinalNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  return withoutFinalNewline === "" ? 0 : withoutFinalNewline.split("\n").length;
};

const isValidUsage = (usage: string) => {
  const lines = usage.split("\n");
  const isBulletList = lines.length <= 3 && lines.every((line) => /^- \S/u.test(line));
  const isProseLine =
    lines.length === 1 && lines[0].trim() !== "" && !MARKDOWN_BLOCK_START.test(lines[0]);
  return isProseLine || isBulletList;
};

const readSection = (readme: string, heading: string) =>
  readme.split(`## ${heading}\n\n`)[1]?.split("\n\n## ")[0];

const readCatalog = (section: string | undefined) =>
  [...(section?.matchAll(CATALOG_ROW_PATTERN) ?? [])].flatMap((match) => {
    const { description, name, target } = match.groups ?? {};
    return description === undefined || name === undefined || target === undefined
      ? []
      : [{ description, name, target }];
  });

const rootReadmePath = path.join(repoRoot, "README.md");
if (existsSync(rootReadmePath)) {
  const rootReadme = readFileSync(rootReadmePath, "utf-8");
  const rootHeadings = rootReadme.split("\n").filter((line) => /^#{1,6}\s/u.test(line));
  const actualPackages = readCatalog(readSection(rootReadme, "Pi extensions"));
  const expectedPackages = packages.map(({ dir, packageJson }) => ({
    description: packageJson.description,
    name: packageJson.name,
    target: dir,
  }));
  const experimentalSection = readSection(rootReadme, "Experimental");
  const actualExperimentalPackages = readCatalog(experimentalSection);
  const expectedExperimentalPackages = experimentalPackages.map(({ dir, packageJson }) => ({
    description: packageJson.description,
    name: packageJson.name,
    target: dir,
  }));

  if (!rootReadme.startsWith("# clanker stuff\n\n")) {
    errors.push("README.md must start with the repository title.");
  }
  if (
    JSON.stringify(actualPackages) !== JSON.stringify(expectedPackages) ||
    JSON.stringify(actualExperimentalPackages) !== JSON.stringify(expectedExperimentalPackages) ||
    (experimentalPackages.length > 0 && experimentalSection?.includes(EXPERIMENTAL_NOTICE) !== true)
  ) {
    errors.push(
      "README.md Pi extensions and Experimental sections must list every extension exactly once in directory order using canonical package metadata, with the fixed experimental instability notice.",
    );
  }
  const expectedRootHeadings = [
    "# clanker stuff",
    "## Pi extensions",
    ...(experimentalPackages.length === 0 ? [] : ["## Experimental"]),
    "## Claude Code plugins",
    "## Codex plugins",
    "## Development",
    "## License",
  ];
  if (
    rootHeadings.length !== expectedRootHeadings.length ||
    rootHeadings.some((heading, index) => heading !== expectedRootHeadings[index])
  ) {
    errors.push("README.md contains an unexpected or misordered heading.");
  }

  for (const { directory, heading } of PLUGIN_CATALOGS) {
    const absoluteDirectory = path.join(repoRoot, directory);
    if (!existsSync(absoluteDirectory)) {
      errors.push(`${directory} is missing.`);
      continue;
    }

    const expectedEntries: [string, string][] = readdirSync(absoluteDirectory, {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry): [string, string] => [entry.name, `${directory}/${entry.name}`])
      .toSorted(([left], [right]) => left.localeCompare(right));
    const actualEntries = readCatalog(readSection(rootReadme, heading)).map(
      ({ name, target }): [string, string] => [name, target],
    );

    if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
      errors.push(
        `README.md ${heading} table must list every plugin directory exactly once in directory order.`,
      );
    }
  }
} else {
  errors.push("README.md is missing.");
}

for (const { dir, packageJson } of packages) {
  const readmePath = path.join(repoRoot, dir, "README.md");
  const description = packageJson.description?.trim();
  const packageName = packageJson.name?.trim();
  const title = path.basename(dir);

  if (description === undefined || description.length === 0) {
    errors.push(`${dir}/package.json is missing a non-empty description.`);
    continue;
  }
  if (packageName === undefined || packageName.length === 0) {
    errors.push(`${dir}/package.json is missing a non-empty name.`);
    continue;
  }
  if (!existsSync(readmePath)) {
    errors.push(`${dir}/README.md is missing.`);
    continue;
  }

  const actual = readFileSync(readmePath, "utf-8");
  const lineCount = countPhysicalLines(actual);
  if (lineCount > MAX_README_LINES) {
    errors.push(`${dir}/README.md has ${lineCount} lines; the maximum is ${MAX_README_LINES}.`);
  }

  const requiredPrefix = `# ${title}\n\n${description}\n\n## Install\n\n${CODE_FENCE}bash\npi install npm:${packageName}\n${CODE_FENCE}\n\n## Usage\n\n`;
  const normalized = actual.trimEnd();
  if (!normalized.startsWith(requiredPrefix)) {
    errors.push(
      `${dir}/README.md must start with the canonical title, description, Install section, and Usage heading from docs/readme-style.md.`,
    );
    continue;
  }

  const tailMatch = PACKAGE_TAIL_PATTERN.exec(normalized.slice(requiredPrefix.length));
  if (tailMatch === null) {
    errors.push(`${dir}/README.md must contain Usage text and at most one allowed final section.`);
    continue;
  }

  const { optionalBody, optionalSection, usage } = tailMatch.groups ?? {};
  if (usage === undefined || !isValidUsage(usage)) {
    errors.push(`${dir}/README.md Usage must be one prose line or up to three short bullets.`);
  }
  if (
    optionalSection !== undefined &&
    (optionalBody === undefined || optionalBody.trim() === "" || /^#{1,6}\s/mu.test(optionalBody))
  ) {
    errors.push(
      `${dir}/README.md ${optionalSection} section must contain text without subsections.`,
    );
  }
}

if (errors.length > 0) {
  console.error("README validation failed:\n");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `README validation passed for the root catalog and ${packages.length} extension packages.`,
);
