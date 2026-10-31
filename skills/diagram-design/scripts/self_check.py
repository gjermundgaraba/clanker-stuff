#!/usr/bin/env python3
"""Check HTML/inline SVG or standalone SVG structure with the Python stdlib.

Checks accessible diagram metadata, viewBox values, IDs and local references,
that an HTML document is whole, and that static content stays inside its viewBox.
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
REPLACEMENT_CHAR = "\ufffd"
# HTML requires these end tags, so an unmatched count is real damage. Elements with an
# optional end tag (html, head, body, p, li, ...) stay out so valid HTML cannot trip it.
PAIRED_TAGS = "title desc div section main article header footer figure figcaption svg g defs pattern marker style script span text tspan".split()
RCDATA_TAGS = ("title", "textarea")
VIEWBOX_TOLERANCE = 2.0
NUMBER = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
NUMBER_RE = re.compile(NUMBER)
PLAIN_NUMBER_RE = re.compile(rf"^\s*{NUMBER}\s*$")
TRANSLATE_RE = re.compile(rf"^\s*translate\(\s*({NUMBER})(?:[\s,]+({NUMBER}))?\s*\)\s*$")
UNPAINTED_TAGS = {"defs", "symbol", "marker", "pattern", "clippath", "mask", "foreignobject", "svg"}
# CSS that can move, hide or clip an element, so its attributes do not give its painted position.
UNSTATIC_CSS = {"transform", "translate", "rotate", "scale", "display", "visibility", "x", "y", "cx", "cy", "r", "rx", "ry", "width", "height"}
UNSTATIC_CSS_PREFIXES = ("animation", "offset", "clip", "mask")
CSS_KEYFRAMES = re.compile(r"@(?:-[a-z]+-)?keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}", re.I)
CSS_RULE = re.compile(r"([^{}]+)\{([^{}]*)\}")


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


class Balance(HTMLParser):
    """Counts parsed tags, so tag-like text in attributes and stylesheets stays opaque.

    `<title>` and `<textarea>` are RCDATA, which HTMLParser only separates from markup on
    Python 3.13+, so markup inside them is skipped here until the matching end tag.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.opens: Counter[str] = Counter()
        self.closes: Counter[str] = Counter()
        self.rcdata = ""

    def handle_starttag(self, tag, attrs):
        if self.rcdata:
            return
        self.opens[tag] += 1
        if tag in RCDATA_TAGS:
            self.rcdata = tag

    def handle_endtag(self, tag):
        if self.rcdata and tag != self.rcdata:
            return
        self.rcdata = ""
        self.closes[tag] += 1


def ends_with_html_close(source: str) -> bool:
    """HTML allows comments and whitespace after `</html>`, so look past them."""
    tail = source.rstrip()
    while tail.endswith("-->") and "<!--" in tail:
        tail = tail[: tail.rfind("<!--")].rstrip()
    return re.search(r"</html\s*>\Z", tail, re.I) is not None


def replacement_errors(source: str) -> list[str]:
    if REPLACEMENT_CHAR not in source:
        return []
    line = source[: source.index(REPLACEMENT_CHAR)].count("\n") + 1
    return [f"contains U+FFFD replacement characters, first on line {line}: mojibake or a truncated multi-byte character"]


def completeness_errors(source: str) -> list[str]:
    """Reject a document that stopped early; its surviving part can otherwise pass every check."""
    parser = Balance()
    parser.feed(source)
    parser.close()
    errors = []
    if parser.opens["html"] and not ends_with_html_close(source):
        errors.append("document does not end with </html>; the file looks truncated")
    if parser.rcdata:
        # Everything after it reads as text, so tag counts would describe the damage, not the cause.
        return [*errors, f"<{parser.rcdata}> is never closed; the rest of the document reads as its text"]
    for tag in PAIRED_TAGS:
        if parser.opens[tag] != parser.closes[tag]:
            errors.append(f"<{tag}> opens {parser.opens[tag]} time(s) and closes {parser.closes[tag]} time(s); the document is not balanced")
    return errors


def declares_unstatic_css(declarations: str) -> bool:
    names = (declaration.split(":", 1)[0].strip().lower() for declaration in declarations.split(";"))
    return any(name in UNSTATIC_CSS or name.startswith(UNSTATIC_CSS_PREFIXES) for name in names)


def selector_subjects(selector: str) -> list[tuple[str, set[str], set[str], set[str]]]:
    """Tag, classes, IDs and attribute names each selector's last compound requires."""
    selector = re.sub(r"\([^()]*\)", "", re.sub(r"\"[^\"]*\"|'[^']*'", "", selector))
    subjects = []
    for alternative in selector.split(","):
        parts = [part for part in re.split(r"\s*[>+~]\s*|\s+", alternative.strip()) if part]
        if not parts:
            continue
        compound = parts[-1].split("::", 1)[0]
        tag = re.match(r"[a-zA-Z][\w-]*", compound)
        subjects.append((tag[0].lower() if tag else "", set(re.findall(r"\.([\w-]+)", compound)),
                         set(re.findall(r"#([\w-]+)", compound)), {name.lower() for name in re.findall(r"\[\s*([\w:-]+)", compound)}))
    return subjects


def unstatic_subjects(sheet: str) -> list[tuple[str, set[str], set[str], set[str]]]:
    """Subjects of rules that move, hide or clip what they match.

    Keeping only the last compound can match more elements than the browser does, which
    only skips checks; it never adds a finding.
    """
    sheet = CSS_KEYFRAMES.sub("", re.sub(r"/\*.*?\*/", "", sheet, flags=re.S))
    return [subject for selector, declarations in CSS_RULE.findall(sheet)
            if declares_unstatic_css(declarations) for subject in selector_subjects(selector)]


def child_offset(node: Node, parent: tuple[float, float], subjects) -> tuple[float, float] | None:
    """Offset of an element in viewBox units, or None when its paint is not static."""
    attrs = node.attrs
    if node.tag in UNPAINTED_TAGS or declares_unstatic_css(attrs.get("style", "")):
        return None
    if attrs.get("display", "").strip().lower() == "none" or attrs.get("visibility", "").strip().lower() in {"hidden", "collapse"}:
        return None
    if any(attrs.get(key, "none").strip().lower() != "none" for key in ("clip-path", "mask")):
        return None
    classes = set(attrs.get("class", "").split())
    if any(tag in {"", "*", node.tag} and required <= classes and ids <= {attrs.get("id", "")} and names <= set(attrs)
           for tag, required, ids, names in subjects):
        return None
    if "transform" not in attrs:
        return parent
    match = TRANSLATE_RE.match(attrs["transform"])
    return (parent[0] + float(match[1]), parent[1] + float(match[2] or 0)) if match else None


def length(attrs: dict[str, str], name: str, default: float | None = None) -> float | None:
    if name not in attrs:
        return default
    return float(attrs[name]) if PLAIN_NUMBER_RE.match(attrs[name]) else None


def painted_points(node: Node) -> list[tuple[float, float]]:
    attrs = node.attrs
    if node.tag == "rect":
        x, y, width, height = length(attrs, "x", 0.0), length(attrs, "y", 0.0), length(attrs, "width"), length(attrs, "height")
        if None in (x, y, width, height) or width <= 0 or height <= 0:
            return []
        return [(x, y), (x + width, y + height)]
    if node.tag == "line":
        ends = [(length(attrs, "x1", 0.0), length(attrs, "y1", 0.0)), (length(attrs, "x2", 0.0), length(attrs, "y2", 0.0))]
        return [(x, y) for x, y in ends if x is not None and y is not None]
    if node.tag in {"circle", "ellipse"}:
        cx, cy = length(attrs, "cx", 0.0), length(attrs, "cy", 0.0)
        rx, ry = length(attrs, "r" if node.tag == "circle" else "rx"), length(attrs, "r" if node.tag == "circle" else "ry")
        if None in (cx, cy, rx, ry) or rx <= 0 or ry <= 0:
            return []
        return [(cx - rx, cy - ry), (cx + rx, cy + ry)]
    if node.tag in {"polygon", "polyline"}:
        numbers = [float(value) for value in NUMBER_RE.findall(attrs.get("points", ""))]
        return list(zip(numbers[0::2], numbers[1::2]))
    if node.tag == "text":
        x, y = length(attrs, "x"), length(attrs, "y")
        return [] if x is None or y is None else [(x, y)]
    return []


def clipped_errors(svg: Node, box: list[float], label: str, subjects) -> list[str]:
    """Report the worst overshoot per edge; paths are skipped because their extent needs a renderer."""
    left, top, width, height = box
    worst: dict[str, tuple[float, str]] = {}

    def visit(parent: Node, offset: tuple[float, float]) -> None:
        for node in parent.children:
            child = child_offset(node, offset, subjects)
            if child is None:
                continue
            for x, y in painted_points(node):
                x, y = x + child[0], y + child[1]
                for side, overshoot in (("left", left - x), ("top", top - y), ("right", x - (left + width)), ("bottom", y - (top + height))):
                    if overshoot > VIEWBOX_TOLERANCE and overshoot > worst.get(side, (0.0, ""))[0]:
                        worst[side] = (overshoot, node.tag)
            visit(node, child)

    visit(svg, (0.0, 0.0))
    return [f"{label}: <{tag}> paints {overshoot:g}px past the viewBox {side} edge and is clipped; grow the viewBox or move the content inside it"
            for side, (overshoot, tag) in worst.items()]


def verify(path: Path, strict_offline: bool = False) -> list[str]:
    source = path.read_text(encoding="utf-8")
    errors = replacement_errors(source)
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
        errors.extend(completeness_errors(source))

    nodes = list(walk(root))
    ids = {node.attrs["id"]: node for node in nodes if node.attrs.get("id")}
    counts = Counter(node.attrs["id"] for node in nodes if node.attrs.get("id"))
    errors.extend(f"duplicate id: {key}" for key, count in counts.items() if count > 1)

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
    subjects = unstatic_subjects("\n".join(node.content() for node in nodes if node.tag == "style"))
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
        if valid:
            errors.extend(clipped_errors(node, box, label, subjects))
        else:
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
