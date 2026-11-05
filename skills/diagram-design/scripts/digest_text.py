"""Text output shared by the diagram extractors."""

import html
import re


def escape_markdown(text: str) -> str:
    encoded = html.escape(text, quote=False)
    return re.sub(r"([\\`*{}\[\]()#+\-.!_|>])", r"\\\1", encoded)


def fold_lines(text: str, replacement: str) -> str:
    return replacement.join(text.splitlines())


def escape_inline(text: str) -> str:
    return escape_markdown(fold_lines(text, " · "))


def escape_table(text: str) -> str:
    return escape_markdown(fold_lines(text, " ⏎ "))
