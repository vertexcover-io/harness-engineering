from __future__ import annotations

from dataclasses import dataclass, replace
from web2md.nodes import Node


@dataclass(frozen=True)
class RenderContext:
    list_depth: int = 0
    list_type: str = ""
    list_index: int = 0
    in_pre: bool = False
    blockquote_depth: int = 0


def render(node: Node) -> str:
    blocks = [_render_node(child, RenderContext()) for child in node.children]
    result = "\n\n".join(b for b in blocks if b)
    return _clean_output(result)


def _render_node(node: Node, ctx: RenderContext) -> str:
    if node.tag == "__text__":
        text = node.text or ""
        if ctx.in_pre:
            return text
        return _collapse_whitespace(text)

    if node.tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
        level = int(node.tag[1])
        return "#" * level + " " + _render_children_inline(node, ctx)

    if node.tag == "p":
        return _render_children_inline(node, ctx)

    if node.tag in ("b", "strong"):
        return _render_inline_wrap(node, ctx, "**")

    if node.tag in ("i", "em"):
        return _render_inline_wrap(node, ctx, "*")

    if node.tag in ("s", "del"):
        return _render_inline_wrap(node, ctx, "~~")

    if node.tag == "code" and not ctx.in_pre:
        return _render_inline_wrap(node, ctx, "`")

    if node.tag == "a":
        return _render_link(node, ctx)

    if node.tag == "img":
        return _render_image(node)

    if node.tag == "table":
        return _render_table(node, ctx)

    if node.tag in ("ul", "ol"):
        return _render_list(node, ctx)

    if node.tag == "li":
        return _render_li(node, ctx)

    if node.tag == "blockquote":
        return _render_blockquote(node, ctx)

    if node.tag == "pre":
        return _render_pre(node, ctx)

    if node.tag == "hr":
        return "---"

    if node.tag == "br":
        return "\n"

    return _render_children_inline(node, ctx)


def _render_list(node: Node, ctx: RenderContext) -> str:
    items: list[str] = []
    index = 1
    for child in node.children:
        if child.tag != "li":
            continue
        child_ctx = replace(ctx, list_type=node.tag, list_depth=ctx.list_depth + 1, list_index=index)
        items.append(_render_node(child, child_ctx))
        index += 1
    return "\n".join(items)


def _render_li(node: Node, ctx: RenderContext) -> str:
    indent = "  " * (ctx.list_depth - 1)
    marker = f"{ctx.list_index}." if ctx.list_type == "ol" else "-"
    content_parts: list[str] = []
    nested_lists: list[str] = []
    for child in node.children:
        if child.tag in ("ul", "ol"):
            nested_lists.append(_render_node(child, ctx))
        else:
            content_parts.append(_render_node(child, ctx))
    content = "".join(content_parts).strip()
    result = f"{indent}{marker} {content}"
    for nested in nested_lists:
        result += "\n" + nested
    return result


def _render_pre(node: Node, ctx: RenderContext) -> str:
    inner_ctx = replace(ctx, in_pre=True)
    content = _render_children_inline(node, inner_ctx)
    content = content.strip("\n")
    return "```\n" + content + "\n```"


def _render_blockquote(node: Node, ctx: RenderContext) -> str:
    inner_ctx = replace(ctx, blockquote_depth=ctx.blockquote_depth + 1)
    blocks = [_render_node(child, inner_ctx) for child in node.children]
    content = "\n\n".join(b for b in blocks if b)
    prefix = "> " * inner_ctx.blockquote_depth
    lines = content.split("\n")
    return "\n".join(prefix + line if line else prefix.rstrip() for line in lines)


def _render_inline_wrap(node: Node, ctx: RenderContext, marker: str) -> str:
    content = _render_children_inline(node, ctx)
    if not content.strip():
        return ""
    return marker + content + marker


def _render_link(node: Node, ctx: RenderContext) -> str:
    href = node.attrs.get("href")
    if not href:
        return ""
    text = _render_children_inline(node, ctx)
    if not text.strip():
        return ""
    return f"[{text}]({href})"


def _render_image(node: Node) -> str:
    src = node.attrs.get("src")
    if not src:
        return ""
    alt = node.attrs.get("alt", "")
    return f"![{alt}]({src})"


def _render_table(node: Node, ctx: RenderContext) -> str:
    rows = _collect_table_rows(node, ctx)
    if not rows:
        return ""
    header = rows[0]
    separator = ["---"] * len(header)
    lines = [_table_row(header), _table_row(separator)]
    for row in rows[1:]:
        lines.append(_table_row(row))
    return "\n".join(lines)


def _collect_table_rows(node: Node, ctx: RenderContext) -> list[list[str]]:
    rows: list[list[str]] = []
    for child in node.children:
        if child.tag == "tr":
            rows.append(_collect_cells(child, ctx))
        elif child.tag in ("thead", "tbody", "tfoot"):
            for grandchild in child.children:
                if grandchild.tag == "tr":
                    rows.append(_collect_cells(grandchild, ctx))
    return rows


def _collect_cells(tr: Node, ctx: RenderContext) -> list[str]:
    cells: list[str] = []
    for child in tr.children:
        if child.tag in ("th", "td"):
            cells.append(_render_children_inline(child, ctx).strip())
    return cells


def _table_row(cells: list[str]) -> str:
    return "| " + " | ".join(cells) + " |"


def _render_children_inline(node: Node, ctx: RenderContext) -> str:
    parts = [_render_node(child, ctx) for child in node.children]
    return "".join(parts)


def _collapse_whitespace(text: str) -> str:
    import re
    return re.sub(r"\s+", " ", text)


def _clean_output(text: str) -> str:
    import re
    lines = text.split("\n")
    lines = [line.rstrip() for line in lines]
    result = "\n".join(lines)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()
