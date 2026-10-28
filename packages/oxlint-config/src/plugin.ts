import { eslintCompatPlugin } from "vite-plus/lint/plugins";
import type { Context, ESTree, Rule } from "vite-plus/lint/plugins";

type Comment = ESTree.Comment;

type Node = ESTree.Node;

const directives = [
  /^(?:oxlint-|eslint-|biome-ignore\b)/u,
  /^@ts-(?:expect-error|ignore|nocheck)\b/u,
  /^(?:prettier|oxfmt)-ignore\b/u,
  /^\/\s*<reference\s/u,
  /^@(?:vitest-environment|jsxImportSource)\b/u,
  /^[@#]__(?:PURE|NO_SIDE_EFFECTS)__$/u,
  /^@vite-ignore$/u,
  /^webpack/u,
  /^(?:istanbul|c8|v8)\s+ignore\b/u,
];

const licenseNotice = /Copyright|SPDX-License-Identifier|License/iu;

const upstreamLink = /https?:\/\//u;

const typeTagTails: ReadonlyMap<string, RegExp> = new Map([
  ["type", /(?:)/uy],
  ["satisfies", /(?:)/uy],
  ["returns", /(?:)/uy],
  ["yields", /(?:)/uy],
  ["typedef", /(?:[\w$]+)?/uy],
  ["callback", /[\w$]+/uy],
  ["param", /\[?[\w$.]+(?:=[^\]\s]*)?\]?/uy],
  ["property", /\[?[\w$.]+(?:=[^\]\s]*)?\]?/uy],
  ["template", /\[?[\w$]+(?:=[^\]]*)?\]?(?:\s*,\s*[\w$]+)*/uy],
  [
    "import",
    /(?:(?:\*\s+as\s+[\w$]+|[\w$]+)\s+)?from\s+(?<quote>["'])[^"']*\k<quote>/uy,
  ],
]);

const tagName = /@(?<tag>\w+)/uy;

const whitespace = /\s*/uy;

const tagEnd = /(?=\s|$)/uy;

const functionTypes = new Set<Node["type"]>([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const isFunctionBody = (node: Node, parent: Node): boolean =>
  functionTypes.has(parent.type) && "body" in parent && parent.body === node;

const isDirective = (comment: Comment): boolean => {
  const text = comment.value.replace(/^\*/u, "").trim();

  return directives.some((directive) => directive.test(text));
};

const matchAt = (pattern: RegExp, text: string, index: number) => {
  pattern.lastIndex = index;

  return pattern.exec(text);
};

const skipWhitespace = (text: string, index: number): number =>
  index + (matchAt(whitespace, text, index)?.[0].length ?? 0);

const skipType = (text: string, start: number): number => {
  if (text[start] !== "{") {
    return start;
  }

  let depth = 0;

  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "{") {
      depth += 1;
    } else if (text[index] === "}") {
      depth -= 1;

      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return -1;
};

const jsDocText = (comment: Comment): string =>
  comment.value
    .slice(1)
    .split("\n")
    .map((line) => line.replace(/^\s*\*?/u, ""))
    .join(" ")
    .trim();

const isJsDoc = (comment: Comment): boolean =>
  comment.type === "Block" && comment.value.startsWith("*");

const isTagOnlyJsDoc = (comment: Comment): boolean => {
  const text = jsDocText(comment);

  let index = 0;

  while (index < text.length) {
    const tag = matchAt(tagName, text, index);

    const tail = typeTagTails.get(tag?.groups?.["tag"] ?? "");

    if (tag === null || tail === undefined) {
      return false;
    }

    index = skipType(text, skipWhitespace(text, index + tag[0].length));

    if (index === -1) {
      return false;
    }

    const tailMatch = matchAt(tail, text, skipWhitespace(text, index));

    if (tailMatch === null) {
      return false;
    }

    index = tailMatch.index + tailMatch[0].length;

    if (matchAt(tagEnd, text, index) === null) {
      return false;
    }

    index = skipWhitespace(text, index);
  }

  return text.length > 0;
};

const namedDeclarations = new Set<Node["type"]>([
  "ClassDeclaration",
  "FunctionDeclaration",
  "TSDeclareFunction",
  "TSEnumDeclaration",
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
]);

const declaredNames = (statement: Node): string[] => {
  if (statement.type === "VariableDeclaration") {
    return statement.declarations.flatMap((declarator) =>
      declarator.id.type === "Identifier" ? [declarator.id.name] : []
    );
  }

  return namedDeclarations.has(statement.type) &&
    "id" in statement &&
    statement.id?.type === "Identifier"
    ? [statement.id.name]
    : [];
};

const exportedNames = (program: ESTree.Program): Set<string> =>
  new Set(
    program.body.flatMap((statement) => {
      if (
        statement.type === "ExportNamedDeclaration" &&
        statement.source === null
      ) {
        return statement.specifiers.map((specifier) =>
          specifier.local.type === "Identifier"
            ? specifier.local.name
            : specifier.local.value
        );
      }

      if (
        statement.type === "ExportDefaultDeclaration" &&
        statement.declaration.type === "Identifier"
      ) {
        return [statement.declaration.name];
      }

      return [];
    })
  );

const documentedNode = (context: Context, comment: Comment): Node | null => {
  const token = context.sourceCode.getTokenAfter(comment);

  if (token === null) {
    return null;
  }

  let node = context.sourceCode.getNodeByRangeIndex(token.start);

  while (
    node !== null &&
    node.parent !== null &&
    node.parent.type !== "Program" &&
    node.parent.start === token.start
  ) {
    node = node.parent;
  }

  return node;
};

const isPublicApi = (node: Node | null, exported: Set<string>): boolean => {
  let current = node;

  while (current !== null) {
    if (
      current.type === "ExportNamedDeclaration" ||
      current.type === "ExportDefaultDeclaration"
    ) {
      return true;
    }

    const { parent } = current;

    if (parent === null || isFunctionBody(current, parent)) {
      return false;
    }

    if (parent.type === "Program") {
      return declaredNames(current).some((declared) => exported.has(declared));
    }

    current = parent;
  }

  return false;
};

const continuesRun = (previous: Comment | undefined, comment: Comment) =>
  previous?.type === "Line" &&
  comment.type === "Line" &&
  comment.loc.start.line === previous.loc.end.line + 1 &&
  comment.loc.start.column === previous.loc.start.column;

const commentRuns = (comments: readonly Comment[]): Comment[][] => {
  const runs: Comment[][] = [];

  for (const comment of comments) {
    const run = runs.at(-1);

    if (run !== undefined && continuesRun(run.at(-1), comment)) {
      run.push(comment);
    } else {
      runs.push([comment]);
    }
  }

  return runs;
};

const isLicenseHeader = (
  run: readonly Comment[],
  index: number,
  program: ESTree.Program
): boolean =>
  index === 0 &&
  (run[0]?.start ?? 0) <=
    (program.body[0]?.start ?? Number.POSITIVE_INFINITY) &&
  run.some((comment) => licenseNotice.test(comment.value));

export const noProseComments: Rule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Allow only license headers, tool directives, tag-only JSDoc, public-API JSDoc and comments that link an upstream source.",
    },
    messages: {
      prose:
        "Express this in names or types; a comment must be a directive, public-API JSDoc, or link an upstream source.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program(program) {
        const comments = context.sourceCode
          .getAllComments()
          .filter((comment) => comment.type !== "Shebang");

        const exported = exportedNames(program);

        for (const [index, run] of commentRuns(comments).entries()) {
          const runAllowed =
            isLicenseHeader(run, index, program) ||
            run.some((comment) => upstreamLink.test(comment.value));

          for (const comment of run) {
            const allowed =
              runAllowed ||
              isDirective(comment) ||
              (isJsDoc(comment) &&
                (isTagOnlyJsDoc(comment) ||
                  isPublicApi(documentedNode(context, comment), exported)));

            if (!allowed) {
              context.report({ loc: comment.loc, messageId: "prose" });
            }
          }
        }
      },
    };
  },
};

export default eslintCompatPlugin({
  meta: { name: "clanker" },
  rules: { "no-prose-comments": noProseComments },
});
