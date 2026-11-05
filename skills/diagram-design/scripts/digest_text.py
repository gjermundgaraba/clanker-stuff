"""Text output shared by the diagram extractors."""

import html
import re
import sys


def configure_stdout_utf8() -> None:
    """Emit digests as UTF-8 even when Windows selects a legacy codepage."""
    reconfigure = getattr(sys.stdout, "reconfigure", None)
    if reconfigure is not None:
        reconfigure(encoding="utf-8", errors="strict")


def escape_markdown(text: str) -> str:
    encoded = html.escape(text, quote=False)
    return re.sub(r"([\\`*{}\[\]()#+\-.!_|>])", r"\\\1", encoded)


def fold_lines(text: str, replacement: str) -> str:
    return replacement.join(text.splitlines())


def escape_inline(text: str) -> str:
    return escape_markdown(fold_lines(text, " · "))


def escape_table(text: str) -> str:
    return escape_markdown(fold_lines(text, " ⏎ "))
