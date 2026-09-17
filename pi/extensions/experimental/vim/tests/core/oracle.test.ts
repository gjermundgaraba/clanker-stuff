import { execFileSync, spawnSync } from "node:child_process";
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
const cases: [string, string[]][] = [
  ["aaa bbb", ["i", "a", "\x1b", "w", "."]],
  ["aaa bbb", ["3i", "a", "\x1b", "w", "."]],
  ["aaa bbb", ["i", "aa", "\x08", "\x1b", "w", "."]],
  ["one\ntwo", ["Vjrx"]],
  ["one\n\ntwo", ["Vjjrx"]],
  ["one\ntwo\n", ["Vjjrx"]],
  ["one\ntwo", ["vjlrx"]],
  ["éx\nyz", ["Vjrx"]],
  ...["one, two! three", " one\n two\nthree", "one\n\ntwo", "αβ γδ εζ", "a b c", "one two"].flatMap(
    (text) =>
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
        ["w", ...(key.startsWith("c") ? [key, "Z", "\x1b"] : [key])],
      ]),
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
    "ccNEW\x1b",
    "cwNEW\x1b",
    "iNEW\x1b",
    "aNEW\x1b",
    "ANEW\x1b",
    "oNEW\x1b",
    "ONEW\x1b",
    "fT",
    "tT",
    "dfT",
    "dtT",
  ].map((command): [string, string[]] => [
    "one Two three",
    command.includes("\x1b") ? [command.slice(0, -1), "\x1b"] : [command],
  ]),
  ...["j", "2j", "G", "gg", "2G", "dj", "2dd", "yyp", "yyP", "J", "3J", "cc", "Vjd"].map(
    (command): [string, string[]] => [
      "one\ntwo\nthree",
      command === "cc" ? ["cc", "NEW", "\x1b"] : [command],
    ],
  ),
  ["say (one [two]) end", ["f[", "di["]],
  ["say (one [two]) end", ["f[", "%"]],
  ["say (one [two]) end", ["f[", "di("]],
  ['say "one two" end', ['f"', 'ci"', "new", "\x1b"]],
  ["one two", ["cw", "new", "\x1b", "w", "."]],
  ["one two", ["x", "."]],
  ["one two", ["s", "\x1b", "."]],
  ["one\ntwo\nthree", ["C", "\x1b", "j", "."]],
  ["one two three four five six", ["2dw", "3."]],
  ["one two", ["3i", "Z", "\x1b"]],
  ["one two", ["3a", "Z", "\x1b", "w", "."]],
  ["one two", ["3o", "Z", "\x1b"]],
  ["one two three", ["vld", "w", "."]],
  ["one two three", ["viwc", "new", "\x1b", "w", "."]],
  ["one\ntwo\nthree", ["Vd", "."]],
  ["a b", ["cw", "new", "\x1b"]],
  ["👩‍💻 é two", ["x"]],
  ["é two", ["x"]],
  // A count after the operator is as explicit as one before it.
  ...["d2G", "2dG", "y2GP", "Gd2gg", "Gy2ggP"].map((keys): [string, string[]] => [
    "abc\ndef\nghi",
    [keys],
  ]),
  // Rightward operators reach past the last character of the last line.
  ...["$dl", "$clZ\x1b", "ld3l", "l3~", "$x", "$~"].map((keys): [string, string[]] => [
    "abcd",
    [keys],
  ]),
  // Shorthand commands are their operator and motion, counts included.
  ...[
    "2D",
    "l2D",
    "2CX\x1b",
    "l2CX\x1b",
    "l2x",
    "l9x",
    "$2X",
    "$9X",
    "l2sZ\x1b",
    "2SZ\x1b",
  ].flatMap((keys): [string, string[]][] => [
    ["abcd\ndef\nghi", [keys]],
    ["abcd\ndef\nghi\njkl\nmno", [keys, "j", "."]],
  ]),
  ["\nxy", ["sZ\x1b"]],
  ["\nxy", ["x"]],
  ["ab\n\nxy", ["jsZ\x1b"]],
  ...["4rX", "3rX", "l2rX", "l3rX"].map((keys): [string, string[]] => ["abc", [keys]]),
  // Visual J joins the selection; uppercase Visual edits take whole lines.
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
    "vlCX\x1b",
    "vlSX\x1b",
    "VCX\x1b",
  ].map((keys): [string, string[]] => ["abc def\n  ghi\njkl", [keys]]),
  // Visual p exchanges the selection with the register; P keeps it.
  ["abc def", ["yiwwviwp$p"]],
  ["abc def", ["yiwwviwP$p"]],
  ["abc\ndef\nghi", ["yyjVpGp"]],
  // A yank rests at the start of what its motion covered.
  ["one two three", ["$ybP"]],
  ["one two three", ["wlyiwP"]],
  ["abc\n def\nghi", ["GykP"]],
  ["abc\n def\nghi", ["jlyjP"]],
  ["abc\n def\nghi", ["jlyyP"]],
  // A vertical motion that cannot move fails, and so does its operator.
  ...["dk", "Gdj", "ykP", "GyjP", "ckZ\x1b", "d5j", "jd5j", "Gd5k", "jd5k", "k", "Gj"].map(
    (keys): [string, string[]] => ["one\ntwo\nthree", [keys]],
  ),
  ["solo", ["dj"]],
  ["solo", ["dk"]],
  // Counted inner words count the whitespace between them; counted "a word" does not.
  ...["one two three", "one  two three", "one, two three"].flatMap((text) =>
    [
      "d2iw",
      "d3iw",
      "d4iw",
      "d2iW",
      "d2aw",
      "d3aw",
      "wd2iw",
      "c2iwZ\x1b",
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
    ].map((keys): [string, string[]] => [text, [keys]]),
  ),
  // A Visual put reconciles the register's type with the selection's.
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
          PI_VIM_ORACLE: JSON.stringify({ lines: text.split("\n"), keys: inputs.join("") }),
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    // SAFETY: The local oracle emits this fixed JSON record from the Lua program above.
    const expected = JSON.parse(output) as { lines: string[]; row: number; col: number };
    const { editor, normal, keys } = setup(text);
    normal();
    // Escape is its own terminal packet; everything else may arrive together.
    keys(
      ...inputs.flatMap((input) =>
        input.split("\x1b").flatMap((part, i) => (i ? ["\x1b", part] : [part]).filter(Boolean)),
      ),
    );
    expect(editor.getText()).toBe(expected.lines.join("\n"));
    const cursor =
      expected.lines.slice(0, expected.row - 1).reduce((n, row) => n + row.length + 1, 0) +
      Buffer.from(expected.lines[expected.row - 1]!)
        .subarray(0, expected.col)
        .toString().length;
    expect(editor.document.cursor()).toBe(cursor);
  });
});
