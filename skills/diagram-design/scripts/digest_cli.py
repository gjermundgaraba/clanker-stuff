"""Command-line output shared by the diagram extractors."""

import argparse
import sys
from collections.abc import Callable
from pathlib import Path
from typing import NoReturn


def configure_stdout_utf8() -> None:
    """Emit digests as UTF-8 even when Windows selects a legacy codepage."""
    reconfigure = getattr(sys.stdout, "reconfigure", None)
    if reconfigure is not None:
        reconfigure(encoding="utf-8", errors="strict")


def add_output_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true", help="emit the full IR as JSON")
    parser.add_argument(
        "--max-rows",
        type=int,
        default=40,
        help="rows per table in the Markdown digest (default 40)",
    )
    parser.add_argument("--out", help="write to this path instead of stdout")


def write_output(text: str, destination: str | None, fail: Callable[[str], NoReturn]) -> None:
    if destination:
        try:
            Path(destination).write_text(text, encoding="utf-8")
        except OSError as error:
            fail(f"cannot write {destination}: {error}")
        print(f"wrote {destination} ({len(text)} bytes)")
    else:
        sys.stdout.write(text if text.endswith("\n") else text + "\n")
