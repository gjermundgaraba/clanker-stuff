"""Measure, size and capture a Herdr pane for UX testing.

usage:
  python3 -I pane.py size <pane>                  print the terminal size the app gets, as COLSxROWS
  python3 -I pane.py size <pane> <cols> <rows>    resize to exactly that size (`-` leaves an axis as it is)
  python3 -I pane.py size <pane> full             close the spacers and give the pane the whole tab
  python3 -I pane.py capture <pane> <dir> <label> save a settled frame as <label>.ansi/.txt/.styles.txt
  python3 -I pane.py shot <pane> <out.png>        capture (same files, named after the PNG), then render it
  python3 -I pane.py wait <pane> [--shown TEXT]... [--gone TEXT]... [--timeout SECONDS]
                                                  wait until every --shown text is on screen and no
                                                  --gone text is, then until the screen settles

A settled frame isn't a ready app: a frame can hold still while a "loading" label is showing.
Wait for the app's ready text and the absence of its loading markers before judging a state.

Sizes come from the pane's terminal (stty), not from `herdr pane layout`, whose rectangle includes
borders and keeps the split size while a pane is zoomed. Measure while the app runs: Herdr
gives a full-screen app one more column than a shell prompt gets. Sizing needs the pane to be the first
(top-left) pane of a tab of its own; it adds panes labelled `size-spacer` to its right and below,
and `full` closes only those.
"""

import json
import os
import subprocess
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ansi  # noqa: E402

SPACER = "size-spacer"


def herdr(*args):
    result = subprocess.run(["herdr", *args], capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"pane.py: herdr {' '.join(args)}: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout if args[:2] == ("pane", "read") else json.loads(result.stdout)["result"]


def measure(pane):
    shell = herdr("pane", "process-info", "--pane", pane)["process_info"].get("shell_pid")
    if not shell:
        sys.exit(f"pane.py: {pane} has no shell; is it still open?")
    tty = subprocess.run(["ps", "-o", "tty=", "-p", str(shell)], capture_output=True, text=True).stdout.strip()
    flag = "-f" if sys.platform == "darwin" else "-F"
    out = subprocess.run(["stty", flag, f"/dev/{tty}", "size"], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"pane.py: can't read the size of /dev/{tty}: {out.stderr.strip()}")
    rows, cols = (int(n) for n in out.stdout.split())
    return cols, rows


def layout(pane):
    return herdr("pane", "layout", "--pane", pane)["layout"]


def neighbour(pane, direction):
    return herdr("pane", "neighbor", "--pane", pane, "--direction", direction)["neighbor"].get("neighbor_pane_id")


def label(pane):
    return herdr("pane", "get", pane)["pane"].get("label")


def spacer_extent(pane, other, axis):
    rect = next(p["rect"] for p in layout(pane)["panes"] if p["pane_id"] == other)
    return rect["width"] if axis == "cols" else rect["height"]


def settle():
    time.sleep(0.25)


def fit(pane, axis, target):
    """Move one split edge until the pane's terminal has `target` cells along `axis`."""
    index, grow, shrink, split = (0, "right", "left", "right") if axis == "cols" else (1, "down", "up", "down")
    previous = None
    for _ in range(12):
        current = measure(pane)[index]
        if current == target:
            return
        other = neighbour(pane, split)
        room = other and current < target and label(other) == SPACER and spacer_extent(pane, other, axis)
        if room and (target - current >= room - 3 or current == previous):
            herdr("pane", "close", other)  # the spacer would be squeezed away; the pane may fit without it
            settle()
            previous = None
            continue
        previous = current
        if not other:
            if target > current:
                sys.exit(f"pane.py: can't reach {target} {axis}; the pane has {current} (`size <pane> full` gives it the whole tab)")
            spacer = herdr("pane", "split", pane, "--direction", split, "--no-focus", "--cwd", "/tmp")["pane"]["pane_id"]
            herdr("pane", "rename", spacer, SPACER)
            settle()
            continue
        area = layout(pane)["area"]
        extent = area["width"] if axis == "cols" else area["height"]
        amount = abs(current - target) / extent
        herdr("pane", "resize", "--pane", pane, "--direction", shrink if current > target else grow, "--amount", f"{amount:.5f}")
        settle()
    sys.exit(
        f"pane.py: can't reach {target} {axis} (got {measure(pane)[index]}). Each split costs a border, so"
        " sizes within a few cells of the whole tab don't exist; `size <pane> full` gives it the whole tab"
    )


def size(pane, args):
    view = layout(pane)
    if args and view.get("zoomed"):
        herdr("pane", "zoom", pane, "--off")
        settle()
    if args == ["full"]:
        for direction in ("down", "right"):
            while (other := neighbour(pane, direction)) and label(other) == SPACER:
                herdr("pane", "close", other)
                settle()
    elif len(args) == 2:
        rect = next(p["rect"] for p in view["panes"] if p["pane_id"] == pane)
        if rect["x"] != view["area"]["x"] or rect["y"] != view["area"]["y"]:
            sys.exit("pane.py: sizing needs the first (top-left) pane of a tab of its own")
        for _ in range(3):  # closing a spacer on one axis can shift the other by a border
            if args[0] != "-":
                fit(pane, "cols", int(args[0]))
            if args[1] != "-":
                fit(pane, "rows", int(args[1]))
            cols, rows = measure(pane)
            if args[0] in ("-", str(cols)) and args[1] in ("-", str(rows)):
                break
    elif args:
        sys.exit(__doc__)
    cols, rows = measure(pane)
    print(f"{cols}x{rows}")


def frame(pane):
    """Read until two reads agree, so a capture isn't taken mid-redraw."""
    last = None
    for _ in range(20):
        current = herdr("pane", "read", pane, "--source", "visible", "--format", "ansi")
        if current == last:
            return current, True
        last = current
        time.sleep(0.2)
    return last, False


def ready(text, shown, gone):
    """True when the screen text holds every `shown` string and none of the `gone` ones."""
    return all(want in text for want in shown) and not any(unwanted in text for unwanted in gone)


def wait(pane, args):
    shown, gone, timeout = [], [], 120.0
    while args:
        flag, value, args = args[0], args[1] if len(args) > 1 else None, args[2:]
        if value is None or flag not in ("--shown", "--gone", "--timeout"):
            sys.exit(__doc__)
        if flag == "--shown":
            shown.append(value)
        elif flag == "--gone":
            gone.append(value)
        else:
            timeout = float(value)
    deadline = time.monotonic() + timeout
    while True:
        text = herdr("pane", "read", pane, "--source", "visible")
        if ready(text, shown, gone):
            frame(pane)
            print("ready")
            return
        if time.monotonic() > deadline:
            sys.exit(f"pane.py: not ready after {timeout:g}s (shown {shown}, gone {gone})")
        time.sleep(0.5)


def capture(pane, folder, name):
    data, settled = frame(pane)
    cols, rows = measure(pane)
    os.makedirs(folder, exist_ok=True)
    base = os.path.join(folder, name)
    lines, _ = ansi.parse(data)
    with open(base + ".ansi", "w", encoding="utf-8") as handle:
        handle.write(data)
    with open(base + ".txt", "w", encoding="utf-8") as handle:
        handle.write(ansi.text(lines) + "\n")
    with open(base + ".styles.txt", "w", encoding="utf-8") as handle:
        handle.write(ansi.summary(lines) + "\n")
    note = f"{time.strftime('%H:%M:%S')} {name} {pane} {cols}x{rows}" + ("" if settled else " still changing")
    with open(os.path.join(folder, "captures.log"), "a", encoding="utf-8") as handle:
        handle.write(note + "\n")
    print(f"{base}.{{ansi,txt,styles.txt}} {cols}x{rows}" + ("" if settled else " (screen was still changing)"))
    return lines


def main(argv):
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__)
    elif argv[:1] == ["size"] and len(argv) >= 2:
        size(argv[1], argv[2:])
    elif argv[:1] == ["wait"] and len(argv) >= 2:
        wait(argv[1], argv[2:])
    elif argv[:1] == ["capture"] and len(argv) == 4:
        capture(*argv[1:])
    elif argv[:1] == ["shot"] and len(argv) == 3:
        out = argv[2]
        lines = capture(argv[1], os.path.dirname(os.path.abspath(out)), os.path.splitext(os.path.basename(out))[0])
        print(ansi.png(lines, out, os.environ.get("BG", "#1e1f1c"), os.environ.get("FG", "#d8dad3")))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except OSError as error:  # a full disk, a missing directory
        sys.exit(f"pane.py: {error}")
