import { execFileSync, spawnSync } from "node:child_process";

import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import { setup } from "../helpers.js";

const available = spawnSync("nvim", ["--version"]).status === 0;

const program = `local case = vim.json.decode(vim.env.PI_VIM_ORACLE)
vim.o.startofline = true
vim.api.nvim_buf_set_lines(0, 0, -1, false, case.lines)
vim.api.nvim_win_set_cursor(0, {1, 0})
vim.cmd.normal({args={case.keys}, bang=true})
local cursor=vim.api.nvim_win_get_cursor(0)
io.write(vim.json.encode({lines=vim.api.nvim_buf_get_lines(0,0,-1,false),row=cursor[1],col=cursor[2]}))`;

const cases: Array<[string, string[]]> = [
  ["aaa bbb", ["i", "a", "\u001B", "w", "."]],
  ["aaa bbb", ["3i", "a", "\u001B", "w", "."]],
  ["aaa bbb", ["i", "aa", "\u0008", "\u001B", "w", "."]],
  ["one\ntwo", ["Vjrx"]],
  ["one\n\ntwo", ["Vjjrx"]],
  ["one\ntwo\n", ["Vjjrx"]],
  ["one\ntwo", ["vjlrx"]],
  ["éx\nyz", ["Vjrx"]],
  ...[
    "one, two! three",
    " one\n two\nthree",
    "one\n\ntwo",
    "αβ γδ εζ",
    "a b c",
    "one two",
  ].flatMap((text) =>
    [
      "w",
      "b",
      "e",
      "W",
      "B",
      "E",
      "dw",
      "db",
      "de",
      "dW",
      "diw",
      "daw",
      "d$",
      "cw",
      "cc",
      "J",
      "dd",
      "yyp",
      "3x",
    ].map((key): [string, string[]] => [
      text,
      ["w", ...(key.startsWith("c") ? [key, "Z", "\u001B"] : [key])],
    ])
  ),
  ...[
    "h",
    "l",
    "3l",
    "w",
    "2w",
    "b",
    "e",
    "2e",
    "$",
    "0",
    "^",
    "dw",
    "d2w",
    "2dw",
    "de",
    "dl",
    "dh",
    "d$",
    "diw",
    "daw",
    "x",
    "3x",
    "D",
    "~",
    "rX",
    "yy",
    "yyp",
    "yylP",
    "ywP",
    "ywp",
    "dd",
    "ccNEW\u001B",
    "cwNEW\u001B",
    "iNEW\u001B",
    "aNEW\u001B",
    "ANEW\u001B",
    "oNEW\u001B",
    "ONEW\u001B",
    "fT",
    "tT",
    "dfT",
    "dtT",
  ].map((command): [string, string[]] => [
    "one Two three",
    command.includes("\u001B") ? [command.slice(0, -1), "\u001B"] : [command],
  ]),
  ...[
    "j",
    "2j",
    "G",
    "gg",
    "2G",
    "dj",
    "2dd",
    "yyp",
    "yyP",
    "J",
    "3J",
    "cc",
    "Vjd",
  ].map((command): [string, string[]] => [
    "one\ntwo\nthree",
    command === "cc" ? ["cc", "NEW", "\u001B"] : [command],
  ]),
  ["say (one [two]) end", ["f[", "di["]],
  ["say (one [two]) end", ["f[", "%"]],
  ["say (one [two]) end", ["f[", "di("]],
  ['say "one two" end', ['f"', 'ci"', "new", "\u001B"]],
  ["one two", ["cw", "new", "\u001B", "w", "."]],
  ["one two", ["x", "."]],
  ["one two", ["s", "\u001B", "."]],
  ["one\ntwo\nthree", ["C", "\u001B", "j", "."]],
  ["one two three four five six", ["2dw", "3."]],
  ["one two", ["3i", "Z", "\u001B"]],
  ["one two", ["3a", "Z", "\u001B", "w", "."]],
  ["one two", ["3o", "Z", "\u001B"]],
  ["one two three", ["vld", "w", "."]],
  ["one two three", ["viwc", "new", "\u001B", "w", "."]],
  ["one\ntwo\nthree", ["Vd", "."]],
  ["a b", ["cw", "new", "\u001B"]],
  ["👩‍💻 é two", ["x"]],
  ["é two", ["x"]],
  ...["d2G", "2dG", "y2GP", "Gd2gg", "Gy2ggP"].map(
    (keys): [string, string[]] => ["abc\ndef\nghi", [keys]]
  ),
  ...["$dl", "$clZ\u001B", "ld3l", "l3~", "$x", "$~"].map(
    (keys): [string, string[]] => ["abcd", [keys]]
  ),
  ...[
    "2D",
    "l2D",
    "2CX\u001B",
    "l2CX\u001B",
    "l2x",
    "l9x",
    "$2X",
    "$9X",
    "l2sZ\u001B",
    "2SZ\u001B",
  ].flatMap((keys): Array<[string, string[]]> => [
    ["abcd\ndef\nghi", [keys]],
    ["abcd\ndef\nghi\njkl\nmno", [keys, "j", "."]],
  ]),
  ["\nxy", ["sZ\u001B"]],
  ["\nxy", ["x"]],
  ["ab\n\nxy", ["jsZ\u001B"]],
  ...["4rX", "3rX", "l2rX", "l3rX"].map((keys): [string, string[]] => [
    "abc",
    [keys],
  ]),
  ...[
    "VjJ",
    "vJ",
    "vjJ",
    "jVkJ",
    "VjjJ",
    "V3J",
    "vlD",
    "vlX",
    "jvjD",
    "vlCX\u001B",
    "vlSX\u001B",
    "VCX\u001B",
  ].map((keys): [string, string[]] => ["abc def\n  ghi\njkl", [keys]]),
  ["abc def", ["yiwwviwp$p"]],
  ["abc def", ["yiwwviwP$p"]],
  ["abc\ndef\nghi", ["yyjVpGp"]],
  ["one two three", ["$ybP"]],
  ["one two three", ["wlyiwP"]],
  ["abc\n def\nghi", ["GykP"]],
  ["abc\n def\nghi", ["jlyjP"]],
  ["abc\n def\nghi", ["jlyyP"]],
  ...[
    "dk",
    "Gdj",
    "ykP",
    "GyjP",
    "ckZ\u001B",
    "d5j",
    "jd5j",
    "Gd5k",
    "jd5k",
    "k",
    "Gj",
  ].map((keys): [string, string[]] => ["one\ntwo\nthree", [keys]]),
  ["solo", ["dj"]],
  ["solo", ["dk"]],
  ...["one two three", "one  two three", "one, two three"].flatMap((text) =>
    [
      "d2iw",
      "d3iw",
      "d4iw",
      "d2iW",
      "d2aw",
      "d3aw",
      "wd2iw",
      "c2iwZ\u001B",
      "y2iw$p",
      "v2iwd",
      "viwiwd",
      "viwiwiwd",
      "viwawd",
      "wviwiwd",
      "llldaw",
      "llld2aw",
      "llldiw",
      "lllvawd",
    ].map((keys): [string, string[]] => [text, [keys]])
  ),
  ...[
    "yiwjVp",
    "yiwjVP",
    "yiwjV2p",
    "yiwGVp",
    "yiwjVjp",
    "yyjVp",
    "yyjV2p",
    "yyGVp",
    "yyjwviwp",
    "yyjwviwP",
    "yyjwviw2p",
    "yyG$vp",
    "yywvjp",
    "yiwjwviwp",
    "yiwjVpGp",
    "yyjwviwpGp",
  ].map((keys): [string, string[]] => ["abc def\n  ghi jkl\nmno pqr", [keys]]),
];

describe.skipIf(!available)("headless Neovim differential oracle", () => {
  it.each(cases)("%s → %j", (text, inputs) => {
    const output = execFileSync(
      "nvim",
      [
        "--headless",
        "-i",
        "NONE",
        "-u",
        "NONE",
        "-n",
        "-c",
        `lua ${program.replaceAll("\n", " ")}`,
        "-c",
        "qa!",
      ],
      {
        env: {
          ...process.env,
          PI_VIM_ORACLE: JSON.stringify({
            lines: text.split("\n"),
            keys: inputs.join(""),
          }),
        },
        encoding: "utf-8",
        timeout: 5000,
      }
    );

    const expected = Value.Parse(
      Type.Object({
        lines: Type.Array(Type.String()),
        row: Type.Integer({ minimum: 1 }),
        col: Type.Integer({ minimum: 0 }),
      }),
      JSON.parse(output)
    );

    const { editor, normal, keys } = setup(text);
    normal();
    keys(
      ...inputs.flatMap((input) =>
        input
          .split("\u001B")
          .flatMap((part, i) => (i ? ["\u001B", part] : [part]).filter(Boolean))
      )
    );
    expect(editor.getText()).toBe(expected.lines.join("\n"));

    const cursor =
      expected.lines
        .slice(0, expected.row - 1)
        .reduce((n, row) => n + row.length + 1, 0) +
      Buffer.from(expected.lines[expected.row - 1]!)
        .subarray(0, expected.col)
        .toString().length;

    expect(editor.document?.cursor()).toBe(cursor);
  });
});
