import os
import subprocess
import sys
import tempfile
import unittest

import ansi

HERE = os.path.dirname(os.path.abspath(__file__))


def summarise(data):
    return ansi.summary(ansi.parse(data)[0])


class Parse(unittest.TestCase):
    def test_a_real_herdr_capture(self):
        with open(os.path.join(HERE, "fixtures", "herdr-styles.ansi"), encoding="utf-8") as handle:
            data = handle.read()
        self.assertEqual(
            summarise(data),
            "{fg=c1}red{} {fg=c9}bright{} {fg=c196}c196{} {fg=#0ac81e}true{} {bg=c4}bgblue{} "
            "{rev}rev{}norm {s}strike{} {i}ital{} {b}bold{}x {d}dim{} {u}und{} {bg=c4} pad   {}|",
        )

    def test_palette_operands_are_not_read_as_styles(self):
        self.assertEqual(summarise("\x1b[38;5;1mA\x1b[48;5;4mB\x1b[38;5;2mC"), "{fg=c1}A{fg=c1 bg=c4}B{fg=c2 bg=c4}C")

    def test_basic_and_bright_codes(self):
        self.assertEqual(summarise("\x1b[31;42mA\x1b[97;104mB"), "{fg=c1 bg=c2}A{fg=c15 bg=c12}B")

    def test_colon_forms(self):
        self.assertEqual(summarise("\x1b[38:2::1:2:3mA\x1b[48:5:9mB"), "{fg=#010203}A{fg=#010203 bg=c9}B")

    def test_resets_turn_single_styles_off(self):
        self.assertEqual(summarise("\x1b[1;2;3;4;7;9mA\x1b[22;23;24;27;29mB"), "{b d i u rev s}A{}B")

    def test_style_carries_across_lines(self):
        self.assertEqual(summarise("\x1b[31mA\nB\x1b[0m"), "{fg=c1}A\n{fg=c1}B")

    def test_trailing_blanks_with_a_background_are_kept(self):
        self.assertEqual(summarise("x   \x1b[44m  \x1b[0m   "), "x   {bg=c4}  ")

    def test_unsupported_sequences_are_dropped_and_counted(self):
        lines, unsupported = ansi.parse("\x1b[38;5mA\x1b[2KB")
        self.assertEqual(ansi.summary(lines), "AB")
        self.assertEqual(sorted(unsupported), ["'\\x1b[2K'", "SGR 38;5"])

    def test_text_drops_styles_and_trailing_blank_rows(self):
        self.assertEqual(ansi.text(ansi.parse("\x1b[1mtitle\x1b[0m  \r\nrow\r\n\r\n   \r\n")[0]), "title\nrow")


class Png(unittest.TestCase):
    def test_a_failed_browser_exits_non_zero_without_output(self):
        with tempfile.TemporaryDirectory() as work:
            source = os.path.join(work, "in.ansi")
            out = os.path.join(work, "out.png")
            with open(source, "w") as handle:
                handle.write("hello\n")
            result = subprocess.run(
                [sys.executable, "-I", os.path.join(HERE, "ansi.py"), "png", source, out],
                capture_output=True,
                env={**os.environ, "CHROME": "/usr/bin/false"},
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(os.path.exists(out))
            self.assertEqual(result.stdout, b"")


if __name__ == "__main__":
    unittest.main()
