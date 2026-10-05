#!/usr/bin/env python3
"""Check HTML/inline SVG or standalone SVG structure with the Python stdlib.

Checks accessible diagram metadata, viewBox values, IDs and local references.
--strict-offline also rejects static asset dependencies outside the file.
This is not a renderer, HTML validator, JavaScript analyzer, or security audit.
"""
from __future__ import annotations

import argparse
import math
import re
from collections import Counter
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote
from xml.etree import ElementTree as ET

VOID = set("area base br col embed hr img input link meta param source track wbr".split())
CSS_URL = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.I | re.S)
CSS_ESCAPE = re.compile(r"\\(?:([0-9a-fA-F]{1,6})\s?|(.))", re.S)
CSS_ATTRS = {"style", "fill", "stroke", "filter", "clip-path", "mask", "marker", "marker-start", "marker-mid", "marker-end", "cursor"}


@dataclass
class Node:
    tag: str
    attrs: dict[str, str]
    children: list[Node] = field(default_factory=list)
    text: str = ""

    def content(self) -> str:
        return self.text + "".join(child.content() for child in self.children)


class Document(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node("document", {})
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, dict((key, value or "") for key, value in attrs))
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_data(self, data):
        self.stack[-1].text += data


def xml_node(element: ET.Element) -> Node:
    def name(value):
        if value.startswith("{http://www.w3.org/1999/xlink}"):
            return "xlink:" + value.split("}", 1)[1].lower()
        return value.rsplit("}", 1)[-1].lower()
    return Node(name(element.tag), {name(k): v for k, v in element.attrib.items()},
                [xml_node(child) for child in element], element.text or "")


def walk(node: Node):
    yield node
    for child in node.children:
        yield from walk(child)


def css_text(value: str) -> str:
    value = re.sub(r"/\*.*?\*/", "", value, flags=re.S)
    def decode(match):
        if not match[1]:
            return match[2]
        code = int(match[1], 16)
        return chr(code) if 0 < code <= 0x10FFFF else "\ufffd"
    return CSS_ESCAPE.sub(decode, value)


def verify(path: Path, strict_offline: bool = False) -> list[str]:
    source = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".svg":
        if re.search(r"<!\s*(DOCTYPE|ENTITY)\b", source, re.I):
            return ["SVG DTD/entity declarations are unsupported; use a plain SVG document"]
        try:
            root = xml_node(ET.fromstring(source))
        except ET.ParseError as error:
            return [f"invalid SVG XML: {error}"]
        if root.tag != "svg":
            return [".svg file needs an SVG root element"]
    else:
        parser = Document()
        parser.feed(source)
        parser.close()
        root = parser.root

    nodes = list(walk(root))
    ids = {node.attrs["id"]: node for node in nodes if node.attrs.get("id")}
    counts = Counter(node.attrs["id"] for node in nodes if node.attrs.get("id"))
    errors = [f"duplicate id: {key}" for key, count in counts.items() if count > 1]

    def reference(value: str, context: str):
        target = unquote(value[1:])
        if target and target not in ids:
            errors.append(f"{context} refers to missing id: {target}")

    def asset(value: str, context: str):
        value = value.strip()
        if value.startswith("#"):
            reference(value, context)
        elif strict_offline and value and not value.lower().startswith("data:"):
            errors.append(f"{context} depends on an external asset: {value[:100]}")

    accessible = []
    for node in nodes:
        attrs = node.attrs
        for key in ("aria-labelledby", "aria-describedby"):
            for target in attrs.get(key, "").split():
                reference("#" + target, f"<{node.tag}> {key}")
        for key in ("href", "xlink:href"):
            value = attrs.get(key, "").strip()
            if value.startswith("#"):
                reference(value, f"<{node.tag}> {key}")
            elif node.tag not in {"a", "base"}:
                asset(value, f"<{node.tag}> {key}")
        for key in ("src", "poster", "data"):
            if key in attrs and (key != "data" or node.tag == "object"):
                asset(attrs[key], f"<{node.tag}> {key}")
        if strict_offline and attrs.get("srcset"):
            errors.append("srcset needs manual inspection or removal for strict offline output")
        if strict_offline and node.tag == "base":
            errors.append("<base> changes resource resolution; remove it for strict offline output")
        css = [attrs[key] for key in CSS_ATTRS if key in attrs]
        if node.tag == "style":
            css.append(node.content())
        for value in css:
            value = css_text(value)
            for match in CSS_URL.finditer(value):
                asset(match[2], f"<{node.tag}> CSS url()")
            if strict_offline and re.search(r"@import\b|(?:-webkit-)?image-set\s*\(", value, re.I):
                errors.append("CSS @import/image-set needs inlining or manual inspection for strict offline output")
        if node.tag == "svg" and attrs.get("aria-hidden", "").lower() != "true":
            accessible.append(node)

    if not accessible:
        errors.append("needs at least one nondecorative SVG (without aria-hidden=true)")
    for index, node in enumerate(accessible, 1):
        attrs = node.attrs
        label = f"svg {index}"
        if attrs.get("role") != "img":
            errors.append(f"{label} needs role=img")
        title = next((n.content().strip() for n in node.children if n.tag == "title"), "")
        desc = next((n.content().strip() for n in node.children if n.tag == "desc"), "")
        labelled = attrs.get("aria-labelledby", "").split()
        name = " ".join(ids[key].content().strip() for key in labelled if key in ids) if labelled else attrs.get("aria-label", title).strip()
        if not name:
            errors.append(f"{label} needs an accessible name (title, aria-label, or aria-labelledby)")
        described = attrs.get("aria-describedby", "").split()
        description = " ".join(ids[key].content().strip() for key in described if key in ids) if described else desc
        if not description:
            errors.append(f"{label} needs a nonempty desc or aria-describedby text")
        try:
            box = [float(value) for value in re.split(r"[\s,]+", attrs.get("viewbox", "").strip())]
            valid = len(box) == 4 and all(math.isfinite(value) for value in box) and box[2] > 0 and box[3] > 0
        except ValueError:
            valid = False
        if not valid:
            errors.append(f"{label} needs a finite viewBox with positive width and height")
    return list(dict.fromkeys(errors))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--strict-offline", action="store_true", help="reject static asset dependencies outside the file; does not analyze JavaScript")
    args = parser.parse_args()
    failed = False
    for path in args.files:
        try:
            errors = verify(path, args.strict_offline)
        except (OSError, UnicodeError, RecursionError) as error:
            errors = [str(error)]
        print(f"{'FAIL' if errors else 'OK'} {path}")
        for error in errors:
            print(f"  - {error}")
        failed |= bool(errors)
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
