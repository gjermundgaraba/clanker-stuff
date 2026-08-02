import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { publishableWorkspacePackages } from "./workspace-packages.mjs";

const CODE_FENCE = "```";
const MAX_README_LINES = 30;
const OPTIONAL_SECTION_NAMES = ["Requirements", "Configuration"];
const OPTIONAL_SECTION_PATTERN = OPTIONAL_SECTION_NAMES.join("|");
const PACKAGE_TAIL_PATTERN = new RegExp(
  `^(?<usage>[\\s\\S]+?)(?:\\n\\n## (?<optionalSection>${OPTIONAL_SECTION_PATTERN})\\n\\n(?<optionalBody>[\\s\\S]+))?$`,
  "u"
);
const MARKDOWN_BLOCK_START =
  /^(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|>\s?|`{3}|~{3}|\|| {4}|\t)/u;

const repoRoot = process.cwd();
const packages = publishableWorkspacePackages()
  .filter(
    ({ dir, packageJson }) =>
      Array.isArray(packageJson.pi?.extensions) &&
      packageJson.pi.extensions.length > 0
  )
  .sort((left, right) => left.dir.localeCompare(right.dir));
const errors = [];

const countPhysicalLines = (text) => {
  const withoutFinalNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  return withoutFinalNewline === ""
    ? 0
    : withoutFinalNewline.split("\n").length;
};

const isValidUsage = (usage) => {
  const lines = usage.split("\n");
  const isBulletList =
    lines.length <= 3 && lines.every((line) => /^- \S/u.test(line));
  const isProseLine =
    lines.length === 1 &&
    lines[0].trim() !== "" &&
    !MARKDOWN_BLOCK_START.test(lines[0]);
  return isProseLine || isBulletList;
};

const rootReadmePath = path.join(repoRoot, "README.md");
if (!existsSync(rootReadmePath)) {
  errors.push("README.md is missing.");
} else {
  const rootReadme = readFileSync(rootReadmePath, "utf8");
  const expectedRows = packages.map(
    ({ dir, packageJson }) =>
      `| [\`${packageJson.name}\`](${dir}) | ${packageJson.description} |`
  );
  const expectedCatalog = [
    "## Extensions",
    "",
    "| Extension | Description |",
    "| --- | --- |",
    ...expectedRows,
  ].join("\n");
  const expectedInstall = `## Install\n\n${CODE_FENCE}bash\npi install npm:@clanker-extensions/<package-name>\n${CODE_FENCE}`;
  const rootHeadings = rootReadme
    .split("\n")
    .filter((line) => /^#{1,6}\s/u.test(line));

  if (!rootReadme.startsWith("# clanker extensions\n\n")) {
    errors.push("README.md must start with the repository title.");
  }
  if (!rootReadme.includes(`${expectedCatalog}\n\n## Install\n`)) {
    errors.push(
      "README.md Extensions table must list every extension exactly once in directory order using canonical package metadata."
    );
  }
  if (!rootReadme.includes(expectedInstall)) {
    errors.push("README.md must contain the generic pi install example.");
  }
  if (
    rootHeadings.length !== 5 ||
    rootHeadings[0] !== "# clanker extensions" ||
    rootHeadings[1] !== "## Extensions" ||
    rootHeadings[2] !== "## Install" ||
    rootHeadings[3] !== "## Development" ||
    rootHeadings[4] !== "## License"
  ) {
    errors.push("README.md contains an unexpected or misordered heading.");
  }
}

for (const { dir, packageJson } of packages) {
  const readmePath = path.join(repoRoot, dir, "README.md");
  const description = packageJson.description?.trim();
  const packageName = packageJson.name?.trim();

  if (!description) {
    errors.push(`${dir}/package.json is missing a non-empty description.`);
    continue;
  }
  if (!packageName) {
    errors.push(`${dir}/package.json is missing a non-empty name.`);
    continue;
  }
  if (!existsSync(readmePath)) {
    errors.push(`${dir}/README.md is missing.`);
    continue;
  }

  const actual = readFileSync(readmePath, "utf8");
  const lineCount = countPhysicalLines(actual);
  if (lineCount > MAX_README_LINES) {
    errors.push(
      `${dir}/README.md has ${lineCount} lines; the maximum is ${MAX_README_LINES}.`
    );
  }

  const requiredPrefix = `# ${dir}\n\n${description}\n\n## Install\n\n${CODE_FENCE}bash\npi install npm:${packageName}\n${CODE_FENCE}\n\n## Usage\n\n`;
  const normalized = actual.trimEnd();
  if (!normalized.startsWith(requiredPrefix)) {
    errors.push(
      `${dir}/README.md must start with the canonical title, description, Install section, and Usage heading from docs/readme-style.md.`
    );
    continue;
  }

  const tailMatch = PACKAGE_TAIL_PATTERN.exec(
    normalized.slice(requiredPrefix.length)
  );
  if (tailMatch === null) {
    errors.push(
      `${dir}/README.md must contain Usage text and at most one allowed final section.`
    );
    continue;
  }

  const { optionalBody, optionalSection, usage } = tailMatch.groups;
  if (!isValidUsage(usage)) {
    errors.push(
      `${dir}/README.md Usage must be one prose line or up to three short bullets.`
    );
  }
  if (
    optionalSection !== undefined &&
    (optionalBody.trim() === "" || /^#{1,6}\s/mu.test(optionalBody))
  ) {
    errors.push(
      `${dir}/README.md ${optionalSection} section must contain text without subsections.`
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
  `README validation passed for the root catalog and ${packages.length} extension packages.`
);
