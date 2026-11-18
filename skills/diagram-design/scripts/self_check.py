#!/usr/bin/env python3
"""Check HTML/inline SVG or standalone SVG structure with the Python stdlib.

Checks accessible diagram metadata, viewBox values, IDs and local references,
that an HTML document is whole, that static content stays inside its viewBox,
and that text inside a visible box fits the per-character width budget.
--strict-offline also rejects static asset dependencies outside the file.
This is not a renderer, HTML validator, JavaScript analyzer, or security audit.
"""
from __future__ import annotations

import argparse
import math
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable
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
# Width budget per character: 0.60em sans, 0.62em mono, 1em for wide and full-width.
SANS_ADVANCE, MONO_ADVANCE, WIDE_ADVANCE = 0.60, 0.62, 1.0
# Half a narrow glyph. The budget averages wider than most faces draw, so a smaller
# overshoot is budget error on a label that fits; a whole character past the edge is not.
TEXT_FIT_TOLERANCE_EM = 0.3
TEXT_FIT_PROPERTIES = ("font-size", "font-family", "text-anchor", "letter-spacing")
# Weight and style move real glyph widths, but the budget already averages over them.
TEXT_FIT_IGNORED = {"font-weight", "font-style"}
# Bidi, vertical and preserved-space text lays out in ways the left-to-right budget can't place.
TEXT_LAYOUT_PROPERTIES = ("direction", "unicode-bidi", "writing-mode", "white-space", "xml:space")
PAINT_PROPERTIES = frozenset({"fill", "stroke", "stroke-width", "fill-opacity", "stroke-opacity", "opacity"})


@dataclass
class Node:
    tag: str
    attrs: dict[str, str]
    children: list[Node] = field(default_factory=list)
    text: str = ""
    tail: str = ""

    def content(self) -> str:
        return self.text + "".join(child.content() + child.tail for child in self.children)


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
        parent = self.stack[-1]
        if parent.children:
            parent.children[-1].tail += data
        else:
            parent.text += data


def xml_node(element: ET.Element) -> Node:
    def name(value):
        for namespace, prefix in (("http://www.w3.org/1999/xlink", "xlink:"), ("http://www.w3.org/XML/1998/namespace", "xml:")):
            if value.startswith("{" + namespace + "}"):
                return prefix + value.split("}", 1)[1].lower()
        return value.rsplit("}", 1)[-1].lower()
    return Node(name(element.tag), {name(k): v for k, v in element.attrib.items()},
                [xml_node(child) for child in element], element.text or "", element.tail or "")


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


def unstatic_property(name: str) -> bool:
    return name in UNSTATIC_CSS or name.startswith(UNSTATIC_CSS_PREFIXES)


def restyles_text_width(name: str) -> bool:
    if name in TEXT_FIT_IGNORED:
        return False
    return name.startswith(("font", "letter-spacing", "word-spacing")) or name == "text-anchor" or name in TEXT_LAYOUT_PROPERTIES


def declares(declarations: str, wanted: Callable[[str], bool]) -> bool:
    return any(wanted(declaration.split(":", 1)[0].strip().lower()) for declaration in declarations.split(";"))


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


def declaring_subjects(sheet: str, wanted: Callable[[str], bool]) -> list[tuple[str, set[str], set[str], set[str]]]:
    """Subjects of rules that declare a property `wanted` accepts, such as one that moves,
    hides or clips what it matches.

    Keeping only the last compound can match more elements than the browser does, which
    only skips checks; it never adds a finding.
    """
    sheet = CSS_KEYFRAMES.sub("", re.sub(r"/\*.*?\*/", "", sheet, flags=re.S))
    return [subject for selector, declarations in CSS_RULE.findall(sheet)
            if declares(declarations, wanted) for subject in selector_subjects(selector)]


def matches(node: Node, subjects) -> bool:
    attrs = node.attrs
    classes = set(attrs.get("class", "").split())
    return any(tag in {"", "*", node.tag} and required <= classes and ids <= {attrs.get("id", "")} and names <= set(attrs)
               for tag, required, ids, names in subjects)


def child_offset(node: Node, parent: tuple[float, float], subjects) -> tuple[float, float] | None:
    """Offset of an element in viewBox units, or None when its paint is not static."""
    attrs = node.attrs
    if node.tag in UNPAINTED_TAGS or declares(attrs.get("style", ""), unstatic_property):
        return None
    if attrs.get("display", "").strip().lower() == "none" or attrs.get("visibility", "").strip().lower() in {"hidden", "collapse"}:
        return None
    if any(attrs.get(key, "none").strip().lower() != "none" for key in ("clip-path", "mask")):
        return None
    if matches(node, subjects):
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


def zero_alpha(value: str) -> bool | None:
    """True for an opacity or colour that paints nothing; None when it can't be read."""
    value = value.strip().lower()
    if value in {"none", "transparent"}:
        return True
    number = re.fullmatch(rf"({NUMBER})(%?)", value)
    if number:
        return float(number[1]) <= 0
    if re.fullmatch(r"#[0-9a-f]{4}|#[0-9a-f]{8}", value):
        return int(value[4] if len(value) == 5 else value[7:], 16) == 0
    function = re.fullmatch(r"(?:rgba?|hsla?)\((.*)\)", value)
    if function:
        parts = [part for part in re.split(r"[\s,/]+", function[1].strip()) if part]
        return zero_alpha(parts[3]) if len(parts) == 4 else False
    return False if value.startswith("#") or value.isalpha() else None


def inline_values(attrs: dict[str, str], wanted: Callable[[str], bool]) -> dict[str, str]:
    """Presentation attributes and inline style declarations, the style attribute winning."""
    values = {name: value.strip() for name, value in attrs.items() if name != "style" and wanted(name)}
    for declaration in attrs.get("style", "").split(";"):
        name, _, value = declaration.partition(":")
        if wanted(name.strip().lower()):
            values[name.strip().lower()] = value.strip()
    return values


def font_size(style: dict[str, str]) -> float | None:
    match = re.fullmatch(rf"\s*({NUMBER})\s*(?:px)?\s*", style.get("font-size", ""))
    return float(match[1]) if match else None


def run_width(text: str, style: dict[str, str]) -> float | None:
    """Budgeted width in px of one run, or None when its style cannot be read statically."""
    size = font_size(style)
    spacing = style.get("letter-spacing", "normal").strip().lower()
    tracking = re.fullmatch(rf"({NUMBER})\s*(em|px)?", spacing)
    if size is None or (spacing != "normal" and tracking is None):
        return None
    glyphs = [char for char in text if unicodedata.category(char) not in {"Mn", "Me"}]
    narrow = MONO_ADVANCE if "mono" in style.get("font-family", "").lower() else SANS_ADVANCE
    advance = sum(WIDE_ADVANCE if unicodedata.east_asian_width(char) in {"W", "F"} else narrow for char in glyphs)
    per_glyph = 0.0 if tracking is None else float(tracking[1]) * (size if tracking[2] == "em" else 1)
    return advance * size + per_glyph * len(glyphs)


def overflow_errors(svg: Node, label: str, subjects, text_subjects, paint_subjects) -> list[str]:
    """Flag text whose budgeted width runs past the visible rect it sits in.

    A line's box is the smallest rect painted before it that contains the line's anchor
    point; a rect whose opacity, fill and stroke draw nothing is no box. Free labels, text
    on a paper-coloured mask, bidi, vertical or space-preserving text, and text whose size,
    spacing, layout, position or paint CSS can change are not checked. A style or paint of
    None below means a stylesheet rule can change it, so its value is unknown here.
    """
    rects: list[tuple[float, float, float, float, str | None, bool]] = []
    papers: set[str | None] = set()
    errors: list[str] = []

    def inherit(node: Node, style, paint):
        if style is not None and not matches(node, text_subjects):
            own = inline_values(node.attrs, lambda name: name in TEXT_FIT_PROPERTIES or name in TEXT_LAYOUT_PROPERTIES or restyles_text_width(name))
            style = None if set(own) - set(TEXT_FIT_PROPERTIES) else {**style, **own}
        else:
            style = None
        if paint is not None and not matches(node, paint_subjects):
            own = {name: value.lower() for name, value in inline_values(node.attrs, PAINT_PROPERTIES.__contains__).items()}
            hidden = paint.get("opacity") == "0" or zero_alpha(own.get("opacity", "1"))
            paint = None if hidden is None else {**paint, **own, "opacity": "0" if hidden else "1"}
        else:
            paint = None
        return style, paint

    def add_rect(node: Node, offset, paint) -> None:
        fill: str | None = None
        stroked = False
        if paint is not None:
            fill, stroke = paint.get("fill", "black"), paint.get("stroke", "none")
            stroked = stroke not in {"none", "transparent"} and paint.get("stroke-width") != "0"
            faded = [zero_alpha(value) for value in (paint["opacity"], fill, paint.get("fill-opacity", "1"),
                                                     stroke, paint.get("stroke-opacity", "1"))]
            if None in faded:
                fill, stroked = None, False
            else:
                fill = "none" if any(faded[:3]) else fill
                stroked = stroked and not any((faded[0], *faded[3:]))
            if node.attrs.get("width", "").strip() == "100%":
                papers.add(fill)
        points = painted_points(node)
        if points and (fill not in {"none", "transparent"} or stroked):
            (x0, y0), (x1, y1) = points
            rects.append((x0 + offset[0], y0 + offset[1], x1 + offset[0], y1 + offset[1], fill, stroked))

    def text_lines(node: Node, offset, style) -> list[dict] | None:
        """Lines of a static text element, each with its anchor point and styled runs."""
        attrs = node.attrs
        x, y = length(attrs, "x"), length(attrs, "y")
        if x is None or y is None or any(name in attrs for name in ("dx", "dy", "rotate", "textlength")):
            return None
        lines = [{"x": x + offset[0], "y": y + offset[1], "style": style, "runs": [], "rects": len(rects)}]

        def collect(parent: Node, offset, style) -> bool:
            if style is None and parent.text:
                return False
            lines[-1]["runs"].append((parent.text, style))
            for child in parent.children:
                child_at = child_offset(child, offset, subjects)
                child_style, _paint = inherit(child, style, {})
                attrs = child.attrs
                if child_at is None or any(name in attrs for name in ("dx", "rotate", "textlength")):
                    return False
                if "x" in attrs:
                    x, y = length(attrs, "x"), length(attrs, "y")
                    if x is None:
                        return False
                    line_y = y + child_at[1] if y is not None else lines[-1]["y"] + (length(attrs, "dy", 0.0) or 0.0)
                    lines.append({"x": x + child_at[0], "y": line_y, "style": child_style, "runs": [], "rects": len(rects)})
                elif "y" in attrs or "dy" in attrs:
                    return False
                if not collect(child, child_at, child_style) or (style is None and child.tail):
                    return False
                lines[-1]["runs"].append((child.tail, style))
            return True

        return lines if style is not None and collect(node, offset, style) else None

    def check_line(line: dict) -> None:
        runs = [(re.sub(r"\s+", " ", run), style) for run, style in line["runs"] if run]
        text = "".join(run for run, _style in runs)
        if not text.strip():
            return
        runs[0] = (runs[0][0].lstrip(), runs[0][1])
        runs[-1] = (runs[-1][0].rstrip(), runs[-1][1])
        widths = [run_width(run, style) for run, style in runs if run]
        if any(width is None for width in widths):
            return
        width = sum(widths)
        size = max(font_size(style) or 0.0 for run, style in runs if run)
        x, y = line["x"], line["y"]
        behind = [rect for rect in rects[: line["rects"]] if rect[0] <= x <= rect[2] and rect[1] <= y <= rect[3]]
        # A paper-coloured mask has no visible edge to overflow. Nodes paint such a mask under
        # their tinted body, so it only decides when it is strictly the smallest rect around the anchor.
        visible = [rect for rect in behind if rect[5] or (rect[4] is not None and rect[4] not in papers)]
        if not visible:
            return
        box = min(visible, key=area)
        if min(map(area, behind)) < area(box) or box[4] is None:
            return
        anchor = line["style"].get("text-anchor", "start").strip().lower()
        start = x - width / 2 if anchor == "middle" else x - width if anchor == "end" else x
        overshoot = max(box[0] - start, start + width - box[2])
        if overshoot > TEXT_FIT_TOLERANCE_EM * size:
            errors.append(f"{label}: text {text.strip()!r} at ({x:g}, {y:g}) is budgeted at {width:.0f}px and overflows its "
                          f"{box[2] - box[0]:g}px box by {overshoot:.0f}px; widen the box or shorten the label "
                          "(budget: 0.60em sans, 0.62em mono per char)")

    def visit(parent: Node, offset, style, paint) -> None:
        for node in parent.children:
            child = child_offset(node, offset, subjects)
            if child is None:
                continue
            node_style, node_paint = inherit(node, style, paint)
            if node.tag == "text":
                for line in text_lines(node, child, node_style) or []:
                    check_line(line)
                continue
            if node.tag == "rect":
                add_rect(node, child, node_paint)
            visit(node, child, node_style, node_paint)

    visit(svg, (0.0, 0.0), *inherit(svg, {}, {"opacity": "1"}))
    return errors


def area(rect: tuple) -> float:
    return (rect[2] - rect[0]) * (rect[3] - rect[1])


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
    sheet = "\n".join(node.content() for node in nodes if node.tag == "style")
    subjects = declaring_subjects(sheet, unstatic_property)
    text_subjects = declaring_subjects(sheet, restyles_text_width)
    paint_subjects = declaring_subjects(sheet, PAINT_PROPERTIES.__contains__)
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
        errors.extend(overflow_errors(node, label, subjects, text_subjects, paint_subjects))
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
