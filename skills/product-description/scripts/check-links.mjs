#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import GithubSlugger from "github-slugger";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString } from "mdast-util-to-string";
import { gfm } from "micromark-extension-gfm";

/** @param {import("mdast").Nodes} node Root of the tree to walk.
 * @returns {Generator<import("mdast").Nodes>} A lazy pre-order traversal of the tree.
 * @yields {import("mdast").Nodes} The root, then each descendant in document order.
 */
const walk = function* (node) {
  yield node;

  if ("children" in node) {
    for (const child of node.children) {
      yield* walk(child);
    }
  }
};

/** @param {string} directory Directory to search recursively.
 * @returns {Generator<string>} A lazy depth-first listing that skips dot entries and `node_modules`.
 * @yields {string} Path of each `.md` file, in directory-listing order; callers sort them.
 */
const markdownFiles = function* (directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }

    const file = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      yield* markdownFiles(file);
    } else if (entry.isFile() && /\.md$/iu.test(entry.name)) {
      yield file;
    }
  }
};

/** @param {string} root Description repository to check. */
const checkLinks = (root) => {
  const files = [...markdownFiles(root)].toSorted();
  /** @type {Map<string, { nodes: import("mdast").Nodes[], anchors: Set<string> }>} */
  const documents = new Map();

  /** @param {string} file Markdown file to parse once. */
  const document = (file) => {
    const cached = documents.get(file);

    if (cached !== undefined) {
      return cached;
    }

    const nodes = [
      ...walk(
        fromMarkdown(readFileSync(file, "utf-8"), {
          extensions: [gfm()],
          mdastExtensions: [gfmFromMarkdown()],
        })
      ),
    ];

    const slugger = new GithubSlugger();

    const parsed = {
      nodes,
      anchors: new Set(
        nodes
          .values()
          .filter((node) => node.type === "heading")
          .map((node) => slugger.slug(toString(node, { includeHtml: false })))
      ),
    };

    documents.set(file, parsed);

    return parsed;
  };

  const problems = [];
  let checked = 0;

  for (const file of files) {
    const { nodes } = document(file);

    /** @type {Map<string, string>} */
    const definitions = new Map();

    // CommonMark resolves duplicate reference definitions to the first one.
    for (const node of nodes) {
      if (node.type === "definition" && !definitions.has(node.identifier)) {
        definitions.set(node.identifier, node.url);
      }
    }

    for (const node of nodes) {
      /** @type {string | undefined} */
      let target;

      if (node.type === "link" || node.type === "image") {
        target = node.url;
      } else if (
        node.type === "linkReference" ||
        node.type === "imageReference"
      ) {
        target = definitions.get(node.identifier);
      }

      if (
        target === undefined ||
        /^[a-z][a-z0-9+.-]*:/iu.test(target) ||
        target.startsWith("//")
      ) {
        continue;
      }

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

      let destination = file;

      if (decodedPath !== "") {
        destination = decodedPath.startsWith("/")
          ? path.resolve(root, `.${decodedPath}`)
          : path.resolve(path.dirname(file), decodedPath);
      }

      if (!existsSync(destination)) {
        problems.push(`${context}: missing file: ${target}`);
      } else if (
        anchor !== "" &&
        /\.md$/iu.test(destination) &&
        !document(destination).anchors.has(anchor)
      ) {
        problems.push(`${context}: missing anchor: ${target}`);
      }
    }
  }

  for (const problem of problems) {
    console.log(problem);
  }

  console.log(
    `${files.length} files, ${checked} relative links, ${problems.length} broken`
  );

  return problems.length === 0 ? 0 : 1;
};

const [root = process.cwd(), ...extra] = process.argv.slice(2);

if (extra.length === 0) {
  try {
    process.exitCode = checkLinks(path.resolve(root));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
} else {
  console.error("Usage: check-links.mjs [description-repository]");
  process.exitCode = 2;
}
