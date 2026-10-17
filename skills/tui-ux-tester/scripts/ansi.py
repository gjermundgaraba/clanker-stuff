"""Read ANSI screen captures from `herdr pane read --format ansi`.

usage:
  python3 -I ansi.py summary [in.ansi]        styled runs: {fg=c1 bg=#0a0b0c b d i u rev s}text
  python3 -I ansi.py text [in.ansi]           plain text, trailing blank rows dropped
  python3 -I ansi.py png <in.ansi> <out.png>  approximate render with headless Chrome

Input defaults to stdin. Colours: `cN` is palette index N, `#rrggbb` is truecolor. Herdr encodes
the 16 basic colours as palette indices 0-15, whose real RGB comes from the user's terminal
theme, so contrast between them can't be judged from a capture. The PNG maps them to a default
dark palette: it shows which cells are styled and how, not the exact colours the user sees.
Set CHROME to the browser binary when it isn't found; BG and FG set the default colours.
Sequences this parser doesn't understand are dropped and listed on stderr.
"""

import html
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from collections import Counter
from dataclasses import dataclass, replace

ESCAPE = re.compile(
    r"\x1b\[([0-9;:?<=>]*)[ -/]*([@-~])"  # CSI, SGR when the final byte is m
    r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC
    r"|\x1b[@-Z\\-_]"  # other two-byte escapes
)


@dataclass(frozen=True)
class Style:
    fg: str | None = None
    bg: str | None = None
    bold: bool = False
    dim: bool = False
    italic: bool = False
    underline: bool = False
    reverse: bool = False
    strike: bool = False

    def visible_when_blank(self):
        return bool(self.bg or self.reverse or self.underline or self.strike)


PLAIN = Style()
FLAGS = (("bold", "b"), ("dim", "d"), ("italic", "i"), ("underline", "u"), ("reverse", "rev"), ("strike", "s"))
SIMPLE = {
    1: {"bold": True},
    2: {"dim": True},
    3: {"italic": True},
    4: {"underline": True},
    7: {"reverse": True},
    9: {"strike": True},
    21: {"underline": True},
    22: {"bold": False, "dim": False},
    23: {"italic": False},
    24: {"underline": False},
    27: {"reverse": False},
    29: {"strike": False},
    39: {"fg": None},
    49: {"bg": None},
}
IGNORED = {5, 6, 8, 25, 28}  # blink and conceal: no visual cue a capture can show


def extended(mode, operands):
    """The colour after 38/48: `5;n` is a palette index, `2;r;g;b` truecolor."""
    if mode == "5" and operands:
        return f"c{int(operands[0] or 0)}"
    if mode == "2" and len(operands) >= 3:
        return "#%02x%02x%02x" % tuple(int(n or 0) for n in operands[-3:])
    return None


def sgr(params, style, unsupported):
    fields = params.split(";") if params else ["0"]
    i = 0
    while i < len(fields):
        sub = fields[i].split(":")
        code = int(sub[0] or 0)
        i += 1
        if code in (38, 48, 58):
            if len(sub) > 1:  # colon form: 38:5:n or 38:2:[colour space]:r:g:b
                colour = extended(sub[1], sub[2:])
            else:  # 38;5;n or 38;2;r;g;b; an unknown mode swallows the rest
                mode = fields[i] if i < len(fields) else ""
                count = {"5": 1, "2": 3}.get(mode, len(fields))
                colour = extended(mode, fields[i + 1 : i + 1 + count])
                i += 1 + count
            if colour is None:
                unsupported[f"SGR {params}"] += 1
            elif code != 58:  # underline colour has no slot here
                style = replace(style, **{"fg" if code == 38 else "bg": colour})
        elif code == 0:
            style = PLAIN
        elif code == 4 and len(sub) > 1:
            style = replace(style, underline=sub[1] != "0")
        elif code in SIMPLE:
            style = replace(style, **SIMPLE[code])
        elif 30 <= code <= 37 or 90 <= code <= 97:
            style = replace(style, fg=f"c{code - 30 if code < 90 else code - 82}")
        elif 40 <= code <= 47 or 100 <= code <= 107:
            style = replace(style, bg=f"c{code - 40 if code < 100 else code - 92}")
        elif code not in IGNORED:
            unsupported[f"SGR {code}"] += 1
    return style


def parse(data):
    """Lines of (text, Style) runs, and a Counter of sequences that were dropped."""
    unsupported = Counter()
    style = PLAIN
    lines = []
    for raw in data.split("\n"):
        raw = raw.rstrip("\r")
        runs, pos = [], 0
        for match in ESCAPE.finditer(raw):
            if match.start() > pos:
                runs.append((raw[pos : match.start()], style))
            pos = match.end()
            if match.group(2) == "m":
                style = sgr(match.group(1), style, unsupported)
            else:
                unsupported[repr(match.group(0))] += 1
        if pos < len(raw):
            runs.append((raw[pos:], style))
        lines.append(merge(runs))
    while lines and not "".join(text for text, _ in lines[-1]).strip():
        lines.pop()
    return lines, unsupported


def merge(runs):
    out = []
    for text, style in runs:
        if out and out[-1][1] == style:
            out[-1] = (out[-1][0] + text, style)
        else:
            out.append((text, style))
    return out


def trim(runs):
    """Drop trailing blanks that draw nothing; keep ones with a background or a line."""
    runs = list(runs)
    while runs:
        text, style = runs[-1]
        if style.visible_when_blank():
            break
        stripped = text.rstrip()
        if stripped:
            runs[-1] = (stripped, style)
            break
        runs.pop()
    return runs


def marker(style):
    parts = [f"{key}={value}" for key, value in (("fg", style.fg), ("bg", style.bg)) if value]
    parts += [short for name, short in FLAGS if getattr(style, name)]
    return "{" + " ".join(parts) + "}"


def summary(lines):
    out = []
    for runs in lines:
        last, parts = PLAIN, []
        for text, style in trim(runs):
            if style != last:
                parts.append(marker(style))
                last = style
            parts.append(text)
        out.append("".join(parts))
    return "\n".join(out)


def text(lines):
    return "\n".join("".join(t for t, _ in runs).rstrip() for runs in lines)


BASIC = [
    "#2e3436", "#cc5f5f", "#6fb05a", "#c9a446", "#5f8fd0", "#a46fc4", "#4fa8a8", "#c8ccc4",
    "#646864", "#f07878", "#8fd474", "#e8c868", "#80aef0", "#c890e0", "#70cccc", "#f0f2ec",
]


def rgb(colour):
    if colour is None or colour.startswith("#"):
        return colour
    n = int(colour[1:])
    if n < 16:
        return BASIC[n]
    if n < 232:
        n -= 16
        level = [0, 95, 135, 175, 215, 255]
        return "#%02x%02x%02x" % (level[n // 36], level[n // 6 % 6], level[n % 6])
    grey = 8 + 10 * (n - 232)
    return "#%02x%02x%02x" % (grey, grey, grey)


def cells(value):
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in value)


def to_html(lines, page_bg, page_fg):
    rows = []
    for runs in lines:
        spans = []
        for value, style in runs:
            fg, bg = rgb(style.fg) or page_fg, rgb(style.bg)
            if style.reverse:
                fg, bg = bg or page_bg, fg
            css = [f"color:{fg}"] + ([f"background:{bg}"] if bg else [])
            css += ["font-weight:bold"] if style.bold else []
            css += ["opacity:.6"] if style.dim else []
            css += ["font-style:italic"] if style.italic else []
            lines_css = [d for d, on in (("underline", style.underline), ("line-through", style.strike)) if on]
            css += [f"text-decoration:{' '.join(lines_css)}"] if lines_css else []
            # One box per cell keeps the grid even when a glyph falls back to a wider font.
            glyphs = "".join(f'<i class="w{cells(ch)}">{html.escape(ch)}</i>' for ch in value)
            spans.append(f'<span style="{";".join(css)}">{glyphs}</span>')
        rows.append("".join(spans))
    font = "font-family:Menlo,'DejaVu Sans Mono','Liberation Mono',monospace;font-size:13px;line-height:16px"
    grid = "i{font-style:inherit;display:inline-block;text-align:center;overflow:visible}.w1{width:1ch}.w2{width:2ch}"
    return (
        f'<html><head><meta charset="utf-8"><style>{grid}</style></head>'
        f'<body style="margin:0;background:{page_bg};color:{page_fg}">'
        f'<pre style="{font};margin:8px">' + "\n".join(rows) + "</pre></body></html>"
    )


def chrome():
    found = os.environ.get("CHROME")
    if found:
        return found
    mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if os.path.exists(mac):
        return mac
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"):
        if shutil.which(name):
            return shutil.which(name)
    sys.exit("ansi.py: no Chrome found; set CHROME to the browser binary")


def png(lines, out, page_bg, page_fg):
    columns = max((cells("".join(t for t, _ in runs)) for runs in lines), default=1)
    width = math.ceil(columns * 7.9) + 24
    height = 16 * max(len(lines), 1) + 16
    target = os.path.abspath(out)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with tempfile.TemporaryDirectory() as work:
        page = os.path.join(work, "screen.html")
        shot = os.path.join(work, "screen.png")
        with open(page, "w", encoding="utf-8") as handle:
            handle.write(to_html(lines, page_bg, page_fg))
        command = [
            chrome(), "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
            "--force-device-scale-factor=2",  # thin box-drawing lines vanish at 1x
            f"--user-data-dir={os.path.join(work, 'profile')}", f"--screenshot={shot}",
            f"--window-size={width},{height}", "file://" + page,
        ]
        try:
            result = subprocess.run(command, capture_output=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired) as error:
            sys.exit(f"ansi.py: Chrome failed: {error}")
        if result.returncode != 0:
            sys.exit(f"ansi.py: Chrome exited {result.returncode}: {result.stderr.decode(errors='replace')[-400:]}")
        if not os.path.exists(shot) or open(shot, "rb").read(8) != b"\x89PNG\r\n\x1a\n":
            sys.exit("ansi.py: Chrome produced no PNG")
        shutil.move(shot, target)
    return target


def main(argv):
    if not argv or argv[0] not in ("summary", "text", "png") or (argv[0] == "png" and len(argv) != 3):
        sys.exit(__doc__)
    command, rest = argv[0], argv[1:]
    source = rest[0] if rest else None
    if source in (None, "-"):
        data = sys.stdin.read()
    else:
        with open(source, encoding="utf-8", errors="replace") as handle:
            data = handle.read()
    lines, unsupported = parse(data)
    if unsupported:
        listed = ", ".join(f"{name} ×{count}" for name, count in unsupported.most_common(5))
        print(f"ansi.py: dropped unsupported sequences: {listed}", file=sys.stderr)
    if command == "summary":
        print(summary(lines))
    elif command == "text":
        print(text(lines))
    else:
        print(png(lines, rest[1], os.environ.get("BG", "#1e1f1c"), os.environ.get("FG", "#d8dad3")))


if __name__ == "__main__":
    main(sys.argv[1:])
