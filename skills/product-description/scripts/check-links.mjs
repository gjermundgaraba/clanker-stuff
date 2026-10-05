#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import GithubSlugger from "github-slugger";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString } from "mdast-util-to-string";
import { gfm } from "micromark-extension-gfm";

/** @param {import("mdast").Nodes} node
 * @returns {Generator<import("mdast").Nodes>}
 */
function* walk(node) {
  yield node;

  if ("children" in node) {
    for (const child of node.children) yield* walk(child);
  }
}

/** @param {string} directory
 * @returns {Generator<string>}
 */
function* markdownFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const file = path.join(directory, entry.name);

    if (entry.isDirectory()) yield* markdownFiles(file);
    else if (entry.isFile() && /\.md$/iu.test(entry.name)) yield file;
  }
}

/** @param {string} root */
function checkLinks(root) {
  const files = [...markdownFiles(root)].sort();
  /** @type {Map<string, import("mdast").Root>} */
  const documents = new Map();

  /** @param {string} file */
  const document = (file) => {
    const cached = documents.get(file);

    if (cached !== undefined) return cached;

    const tree = fromMarkdown(readFileSync(file, "utf8"), {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    });

    documents.set(file, tree);

    return tree;
  };

  /** @type {Map<string, Set<string>>} */
  const anchors = new Map();

  /** @param {string} file */
  const headingAnchors = (file) => {
    const cached = anchors.get(file);

    if (cached !== undefined) return cached;
    const slugger = new GithubSlugger();

    const headings = new Set(
      [...walk(document(file))]
        .filter((node) => node.type === "heading")
        .map((node) => slugger.slug(toString(node, { includeHtml: false }))),
    );

    anchors.set(file, headings);

    return headings;
  };

  const problems = [];
  let checked = 0;

  for (const file of files) {
    const nodes = [...walk(document(file))];

    /** @type {Map<string, string>} */
    const definitions = new Map();

    // CommonMark resolves duplicate reference definitions to the first one.
    for (const node of nodes) {
      if (node.type === "definition" && !definitions.has(node.identifier)) {
        definitions.set(node.identifier, node.url);
      }
    }

    for (const node of nodes) {
      const target =
        node.type === "link" || node.type === "image"
          ? node.url
          : node.type === "linkReference" || node.type === "imageReference"
            ? definitions.get(node.identifier)
            : undefined;

      if (target === undefined || /^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("//"))
        continue;
      checked += 1;
      const context = `${path.relative(root, file)}:${node.position?.start.line ?? 1}`;
      const hash = target.indexOf("#");
      const filePart = hash === -1 ? target : target.slice(0, hash);
      const fragment = hash === -1 ? "" : target.slice(hash + 1);
      let decodedPath;
      let anchor;

      try {
        decodedPath = decodeURIComponent(filePart);
        anchor = decodeURIComponent(fragment);
      } catch {
        problems.push(`${context}: invalid URL encoding: ${target}`);
        continue;
      }

      const destination =
        decodedPath === ""
          ? file
          : decodedPath.startsWith("/")
            ? path.resolve(root, `.${decodedPath}`)
            : path.resolve(path.dirname(file), decodedPath);

      if (!existsSync(destination)) {
        problems.push(`${context}: missing file: ${target}`);
      } else if (
        anchor !== "" &&
        /\.md$/iu.test(destination) &&
        !headingAnchors(destination).has(anchor)
      ) {
        problems.push(`${context}: missing anchor: ${target}`);
      }
    }
  }

  for (const problem of problems) console.log(problem);
  console.log(`${files.length} files, ${checked} relative links, ${problems.length} broken`);

  return problems.length === 0 ? 0 : 1;
}

const [root = process.cwd(), ...extra] = process.argv.slice(2);

if (extra.length !== 0) {
  console.error("Usage: check-links.mjs [description-repository]");
  process.exitCode = 2;
} else {
  try {
    process.exitCode = checkLinks(path.resolve(root));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
