from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag
from bs4.element import NavigableString, PageElement

STRIPPED_TAGS = frozenset({"script", "style", "nav", "footer", "header", "aside"})
BLOCK_TAGS = frozenset({
    "p", "div", "h1", "h2", "h3", "h4", "h5", "h6",
    "hr", "blockquote", "pre", "ul", "ol", "li",
    "table", "dl", "section", "article", "main",
})


@dataclass
class ConversionContext:
    base_url: str = ""
    list_depth: int = 0
    list_type: list[str] = field(default_factory=list)
    ol_counters: list[int] = field(default_factory=list)
    blockquote_depth: int = 0
    in_pre: bool = False


def strip_unwanted_tags(soup: BeautifulSoup | Tag) -> None:
    for tag_name in STRIPPED_TAGS:
        for el in soup.find_all(tag_name):
            el.decompose()


def _resolve_url(url: str, ctx: ConversionContext) -> str:
    if not url:
        return url
    return urljoin(ctx.base_url, url)


def _collapse_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def _convert_children(tag: Tag, ctx: ConversionContext) -> str:
    parts: list[str] = []
    for child in tag.children:
        parts.append(_convert_node(child, ctx))
    return "".join(parts)


def _handle_heading(tag: Tag, ctx: ConversionContext) -> str:
    level = int(tag.name[1])
    text = _convert_children(tag, ctx).strip()
    if not text:
        return ""
    return f"\n\n{'#' * level} {text}\n\n"


def _handle_paragraph(tag: Tag, ctx: ConversionContext) -> str:
    text = _convert_children(tag, ctx).strip()
    if not text:
        return ""
    return f"\n\n{text}\n\n"


def _handle_link(tag: Tag, ctx: ConversionContext) -> str:
    href = tag.get("href")
    text = _convert_children(tag, ctx).strip()
    if not href:
        return text
    resolved = _resolve_url(str(href), ctx)
    return f"[{text}]({resolved})"


def _handle_image(tag: Tag, ctx: ConversionContext) -> str:
    src = tag.get("src", "")
    alt = tag.get("alt", "")
    resolved = _resolve_url(str(src), ctx)
    return f"![{alt}]({resolved})"


def _handle_bold(tag: Tag, ctx: ConversionContext) -> str:
    text = _convert_children(tag, ctx)
    if not text.strip():
        return ""
    return f"**{text}**"


def _handle_italic(tag: Tag, ctx: ConversionContext) -> str:
    text = _convert_children(tag, ctx)
    if not text.strip():
        return ""
    return f"*{text}*"


def _handle_strikethrough(tag: Tag, ctx: ConversionContext) -> str:
    text = _convert_children(tag, ctx)
    if not text.strip():
        return ""
    return f"~~{text}~~"


def _handle_inline_code(tag: Tag, ctx: ConversionContext) -> str:
    text = tag.get_text()
    if not text:
        return ""
    if "`" in text:
        return f"`` {text} ``"
    return f"`{text}`"


def _handle_hr(tag: Tag, ctx: ConversionContext) -> str:
    return "\n\n---\n\n"


def _handle_br(tag: Tag, ctx: ConversionContext) -> str:
    return "\n"


def _handle_transparent(tag: Tag, ctx: ConversionContext) -> str:
    return _convert_children(tag, ctx)


def _handle_ul(tag: Tag, ctx: ConversionContext) -> str:
    ctx.list_depth += 1
    ctx.list_type.append("ul")
    result = _convert_children(tag, ctx)
    ctx.list_type.pop()
    ctx.list_depth -= 1
    if ctx.list_depth == 0 and ctx.blockquote_depth == 0:
        return f"\n\n{result}\n\n"
    return result


def _handle_ol(tag: Tag, ctx: ConversionContext) -> str:
    ctx.list_depth += 1
    ctx.list_type.append("ol")
    ctx.ol_counters.append(0)
    result = _convert_children(tag, ctx)
    ctx.ol_counters.pop()
    ctx.list_type.pop()
    ctx.list_depth -= 1
    if ctx.list_depth == 0 and ctx.blockquote_depth == 0:
        return f"\n\n{result}\n\n"
    return result


def _handle_li(tag: Tag, ctx: ConversionContext) -> str:
    indent = "  " * (ctx.list_depth - 1)
    current_type = ctx.list_type[-1] if ctx.list_type else "ul"

    if current_type == "ol":
        ctx.ol_counters[-1] += 1
        marker = f"{ctx.ol_counters[-1]}. "
    else:
        marker = "- "

    parts: list[str] = []
    nested: list[str] = []
    for child in tag.children:
        if isinstance(child, Tag) and child.name in ("ul", "ol"):
            nested.append(_convert_node(child, ctx))
        else:
            parts.append(_convert_node(child, ctx))

    text = "".join(parts).strip()
    if not text and not nested:
        return ""

    line = f"{indent}{marker}{text}\n"
    for n in nested:
        line += n
    return line


def _apply_blockquote_prefix(text: str, depth: int) -> str:
    prefix = "> " * depth
    lines = text.split("\n")
    result: list[str] = []
    for line in lines:
        if line.strip():
            result.append(f"{prefix}{line}")
        else:
            result.append(line)
    return "\n".join(result)


def _handle_blockquote(tag: Tag, ctx: ConversionContext) -> str:
    ctx.blockquote_depth += 1
    raw = _convert_children(tag, ctx)
    ctx.blockquote_depth -= 1

    text = raw.strip()
    prefixed = _apply_blockquote_prefix(text, 1)
    if ctx.blockquote_depth == 0:
        return f"\n\n{prefixed}\n\n"
    return f"\n{prefixed}\n"


def _extract_language(code_tag: Tag) -> str:
    cls = code_tag.get("class")
    if isinstance(cls, list):
        for c in cls:
            if c.startswith("language-"):
                return c[len("language-"):]
            return c
    return ""


def _handle_pre(tag: Tag, ctx: ConversionContext) -> str:
    code_tag = tag.find("code")
    lang = ""
    if isinstance(code_tag, Tag):
        lang = _extract_language(code_tag)
        ctx.in_pre = True
        text = code_tag.get_text()
        ctx.in_pre = False
    else:
        ctx.in_pre = True
        text = tag.get_text()
        ctx.in_pre = False

    return f"\n\n```{lang}\n{text}\n```\n\n"


def _handle_table(tag: Tag, ctx: ConversionContext) -> str:
    rows: list[list[str]] = []
    thead = tag.find("thead")
    tbody = tag.find("tbody")

    if isinstance(thead, Tag):
        for tr in thead.find_all("tr", recursive=False):
            if isinstance(tr, Tag):
                cells = [_convert_children(cell, ctx).strip()
                         for cell in tr.find_all(["th", "td"], recursive=False)
                         if isinstance(cell, Tag)]
                rows.append(cells)

    body_source = tbody if isinstance(tbody, Tag) else tag
    for tr in body_source.find_all("tr", recursive=False):
        if isinstance(tr, Tag):
            cells = [_convert_children(cell, ctx).strip()
                     for cell in tr.find_all(["th", "td"], recursive=False)
                     if isinstance(cell, Tag)]
            if cells:
                rows.append(cells)

    if not rows:
        return ""

    header = rows[0]
    body_rows = rows[1:]
    header_line = "| " + " | ".join(header) + " |"
    sep_line = "| " + " | ".join("---" for _ in header) + " |"
    lines = [header_line, sep_line]
    for row in body_rows:
        lines.append("| " + " | ".join(row) + " |")

    return "\n\n" + "\n".join(lines) + "\n\n"


def _handle_dl(tag: Tag, ctx: ConversionContext) -> str:
    result = _convert_children(tag, ctx)
    return f"\n\n{result.strip()}\n\n"


def _handle_dt(tag: Tag, ctx: ConversionContext) -> str:
    text = _convert_children(tag, ctx).strip()
    if not text:
        return ""
    return f"**{text}**\n"


def _handle_dd(tag: Tag, ctx: ConversionContext) -> str:
    text = _convert_children(tag, ctx).strip()
    if not text:
        return ""
    return f": {text}\n"


HANDLERS: dict[str, Callable[[Tag, ConversionContext], str]] = {
    "h1": _handle_heading,
    "h2": _handle_heading,
    "h3": _handle_heading,
    "h4": _handle_heading,
    "h5": _handle_heading,
    "h6": _handle_heading,
    "p": _handle_paragraph,
    "a": _handle_link,
    "img": _handle_image,
    "strong": _handle_bold,
    "b": _handle_bold,
    "em": _handle_italic,
    "i": _handle_italic,
    "del": _handle_strikethrough,
    "s": _handle_strikethrough,
    "code": _handle_inline_code,
    "hr": _handle_hr,
    "br": _handle_br,
    "span": _handle_transparent,
    "div": _handle_transparent,
    "section": _handle_transparent,
    "article": _handle_transparent,
    "main": _handle_transparent,
    "ul": _handle_ul,
    "ol": _handle_ol,
    "li": _handle_li,
    "blockquote": _handle_blockquote,
    "pre": _handle_pre,
    "table": _handle_table,
    "thead": _handle_transparent,
    "tbody": _handle_transparent,
    "tr": _handle_transparent,
    "th": _handle_transparent,
    "td": _handle_transparent,
    "dl": _handle_dl,
    "dt": _handle_dt,
    "dd": _handle_dd,
}


def _convert_node(node: PageElement, ctx: ConversionContext) -> str:
    if isinstance(node, NavigableString):
        text = str(node)
        if ctx.in_pre:
            return text
        return _collapse_whitespace(text)

    if not isinstance(node, Tag):
        return ""

    handler = HANDLERS.get(node.name)
    if handler:
        return handler(node, ctx)

    return _convert_children(node, ctx)


def _detect_base_url(soup: BeautifulSoup | Tag, fallback_url: str) -> str:
    base_tag = soup.find("base")
    if base_tag and isinstance(base_tag, Tag):
        href = base_tag.get("href")
        if href:
            return str(href)
    return fallback_url


def _normalize_output(text: str) -> str:
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n" if text.strip() else ""


def convert(soup: BeautifulSoup | Tag, base_url: str) -> str:
    resolved_base = _detect_base_url(soup, base_url)
    strip_unwanted_tags(soup)

    ctx = ConversionContext(base_url=resolved_base)

    body = soup.find("body") if isinstance(soup, BeautifulSoup) else soup
    if body is None:
        body = soup

    raw = _convert_node(body, ctx) if isinstance(body, Tag) else ""
    return _normalize_output(raw)
