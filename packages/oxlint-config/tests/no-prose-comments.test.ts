import { RuleTester } from "vite-plus/lint/plugins-dev";
import { describe, expect, it } from "vite-plus/test";

import { noProseComments } from "../src/plugin.ts";

const prose = [{ messageId: "prose" }];

const tester = new RuleTester({
  languageOptions: { sourceType: "module", parserOptions: { lang: "ts" } },
});

const lines = (...source: string[]) => source.join("\n");

const cases = {
  valid: [
    {
      name: "a shebang and a license header",
      code: lines(
        "#!/usr/bin/env node",
        "/* Copyright (c) 2026 Someone. Licensed under MIT. */",
        "load();"
      ),
    },
    {
      name: "a license header of several line comments",
      code: lines(
        "// Adapted from upstream's config loader",
        "// (MIT, Copyright (c) 2025 Someone).",
        "load();"
      ),
    },
    {
      name: "an SPDX identifier",
      code: "// SPDX-License-Identifier: MIT\nload();",
    },
    ...[
      "// oxlint-disable-next-line no-console -- The CLI owns stdout.",
      "/* eslint-disable no-console */",
      "// biome-ignore lint/style: generated",
      "// @ts-expect-error",
      "// @ts-expect-error -- The fixture is malformed on purpose.",
      "// @ts-ignore",
      "// @ts-nocheck",
      "// prettier-ignore",
      "// oxfmt-ignore",
      '/// <reference types="node" />',
      "// @vitest-environment node",
      "/** @vitest-environment node */",
      "/** @jsxImportSource solid-js */",
      "/* istanbul ignore next */",
      "/* c8 ignore next */",
      "/* v8 ignore start */",
    ].map((directive) => ({
      name: `the directive ${directive}`,
      code: `${directive}\nload();`,
    })),
    {
      name: "annotations a bundler reads",
      code: lines(
        "export const a = /* @__PURE__ */ create();",
        "export const b = /*#__PURE__*/ create();",
        "/* #__NO_SIDE_EFFECTS__ */",
        "export function create() { return 1; }",
        "export const c = import(/* @vite-ignore */ path);",
        'export const d = import(/* webpackChunkName: "d" */ "./d.js");'
      ),
    },
    {
      name: "tag-only JSDoc in any position",
      code: lines(
        '/** @import { Route } from "./route.js" */',
        "/**",
        " * @typedef {object} Options",
        " * @property {string} name",
        " * @property {{ depth: number }} [nested]",
        " */",
        "/** @typedef {{ a: string }} Pair */",
        "/**",
        " * @template T, U",
        " * @param {T} first",
        " * @param {U} [second]",
        " * @returns {[T, U]}",
        " */",
        "function pair(first, second) {",
        "  /** @type {Options} */",
        "  const options = /** @type {Options} */ (load());",
        "  return /** @satisfies {Pair} */ ([first, second, options]);",
        "}",
        "/** @yields {number} */",
        "function* count() {",
        "  yield 1;",
        "}",
        "/**",
        " * @callback Handler",
        " * @param {string} event",
        " * @returns {void}",
        " */",
        "pair(count());"
      ),
    },
    {
      name: "JSDoc on exported declarations and their members",
      code: lines(
        "/** Loads the settings. */",
        "export function load() { return 1; }",
        "/** The parsed settings. */",
        "export interface Settings {",
        "  /** Where the settings live. */",
        "  readonly path: string;",
        "}",
        "export type Shape = {",
        "  /** The radius in pixels. */",
        "  radius: number;",
        "};",
        "export class Store {",
        "  /** Reads one key. */",
        "  read(key: string) { return key; }",
        "  /** The number of reads. */",
        "  count = 0;",
        "}",
        "export const defaults = {",
        "  /** The default depth. */",
        "  depth: 1,",
        "  nested: {",
        "    /** The default width. */",
        "    width: 2,",
        "  },",
        "};",
        "/** The default export. */",
        "export default class Runner {}"
      ),
    },
    {
      name: "JSDoc on a declaration exported by name",
      code: lines(
        "/** Saves the settings. */",
        "function save() { return 1; }",
        "/** The saved shape. */",
        "interface Saved {",
        "  /** When it was saved. */",
        "  at: number;",
        "}",
        "export { save, type Saved };"
      ),
    },
    {
      name: "JSDoc on properties of an object passed to a call in an exported const",
      code: lines(
        "export const User = Schema.Struct({",
        "  /** The display name. */",
        "  name: Schema.String,",
        "  address: Schema.Struct({",
        "    /** The postal code. */",
        "    zip: Schema.String,",
        "  }),",
        "});"
      ),
    },
    {
      name: "JSDoc on members of a Context.Tag service shape",
      code: lines(
        'export class Users extends Context.Tag("Users")<',
        "  Users,",
        "  {",
        "    /** Finds a user by id. */",
        "    readonly find: (id: string) => Effect.Effect<User>;",
        "  }",
        ">() {}"
      ),
    },
    {
      name: "JSDoc on the fields of a tagged error",
      code: lines(
        'export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {',
        "  /** The id nobody owns. */",
        "  id: Schema.String,",
        "}) {}"
      ),
    },
    {
      name: "JSDoc on the arms of an exported union",
      code: lines(
        "export type Reason =",
        "  /** The history moved away. */",
        '  | "diverged"',
        "  /** The session file is missing. */",
        '  | "missing";'
      ),
    },
    {
      name: "JSDoc on a call argument's property of a const exported by name",
      code: lines(
        "const Settings = Schema.Struct({ /** The depth. */ depth: Schema.Number });",
        "export { Settings };"
      ),
    },
    {
      name: "a comment that links an upstream source",
      code: lines(
        "// The SDK drops empty tool lists: https://github.com/owner/repo/issues/1",
        "load();",
        "/* See http://example.com/spec#section */",
        "load();",
        "  // A fact that needs two lines, with its source",
        "  // on the second: https://example.com/docs#fact",
        "load();"
      ),
    },
  ],
  invalid: [
    {
      name: "a line comment of prose",
      code: "// Loads the user.\nexport const load = () => 1;",
      errors: prose,
    },
    {
      name: "a block comment of prose",
      code: "/* Loads the user. */\nexport const load = () => 1;",
      errors: prose,
    },
    {
      name: "a trailing comment of prose",
      code: "export const load = () => 1; // Loads the user.",
      errors: prose,
    },
    {
      name: "a TODO",
      code: "// TODO: cache this.\nload();",
      errors: prose,
    },
    {
      name: "a license word after code and outside the header",
      code: "load();\n// See the License for details.\nload();",
      errors: prose,
    },
    {
      name: "a header without a license notice",
      code: "// Loads things.\n// Second line.\nload();",
      errors: [{ messageId: "prose" }, { messageId: "prose" }],
    },
    {
      name: "JSDoc on a module-private declaration",
      code: lines(
        "/** Loads the user. */",
        "function load() { return 1; }",
        "/** The user. */",
        "interface User {",
        "  /** The name. */",
        "  name: string;",
        "}",
        "export const run = () => load();"
      ),
      errors: [
        { messageId: "prose" },
        { messageId: "prose" },
        { messageId: "prose" },
      ],
    },
    {
      name: "JSDoc inside an exported function's body",
      code: lines(
        "export function run() {",
        "  /** The answer. */",
        "  const answer = 42;",
        "  return { /** The value. */ value: answer };",
        "}"
      ),
      errors: [{ messageId: "prose" }, { messageId: "prose" }],
    },
    {
      name: "JSDoc on a call argument's property inside a module-private const",
      code: lines(
        "const Private = Schema.Struct({ /** The name. */ name: Schema.String });",
        "export const run = () => Private;"
      ),
      errors: prose,
    },
    {
      name: "tag JSDoc that carries prose",
      code: lines(
        "/**",
        " * @param {string} name The user's name.",
        " * @returns {number} How many matched.",
        " */",
        "function count(name) { return name.length; }",
        "count();"
      ),
      errors: prose,
    },
    {
      name: "prose separated from a linked comment by a blank line",
      code: "// https://example.com/docs\nload();\n\n// Loads again.\nload();",
      errors: prose,
    },
    {
      name: "an empty JSDoc block",
      code: "/** */\nload();",
      errors: prose,
    },
    {
      name: "a directive name that only starts the prose",
      code: "// eslint is not used here.\nload();",
      errors: prose,
    },
  ],
};

describe("no-prose-comments", () => {
  it("reports prose and allows only the listed forms", () => {
    expect(() => {
      tester.run("no-prose-comments", noProseComments, cases);
    }).not.toThrow();
  });
});
