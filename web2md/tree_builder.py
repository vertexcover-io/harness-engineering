from __future__ import annotations
from html.parser import HTMLParser

from web2md.nodes import Node

VOID_ELEMENTS = frozenset({
    "br", "hr", "img", "input", "meta", "link",
    "area", "base", "col", "embed", "source", "track", "wbr",
})

STRIP_TAGS = frozenset({"script", "style", "nav", "footer", "header"})

IMPLICIT_CLOSE_TAGS = frozenset({"p", "li", "dd", "dt", "option"})


class TreeBuilder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.root = Node(tag="__root__")
        self._stack: list[Node] = [self.root]
        self._skip_depth: int = 0

    def _current(self) -> Node:
        return self._stack[-1]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self._skip_depth > 0:
            if tag in STRIP_TAGS:
                self._skip_depth += 1
            return

        if tag in STRIP_TAGS:
            self._skip_depth = 1
            return

        if tag in IMPLICIT_CLOSE_TAGS and self._current().tag == tag:
            self._stack.pop()

        attr_dict = {k: (v or "") for k, v in attrs}
        node = Node(tag=tag, attrs=attr_dict)
        self._current().children.append(node)

        if tag not in VOID_ELEMENTS:
            self._stack.append(node)

    def handle_endtag(self, tag: str) -> None:
        if self._skip_depth > 0:
            if tag in STRIP_TAGS:
                self._skip_depth -= 1
            return

        if tag in VOID_ELEMENTS:
            return

        for i in range(len(self._stack) - 1, 0, -1):
            if self._stack[i].tag == tag:
                self._stack = self._stack[:i]
                return

    def handle_data(self, data: str) -> None:
        if self._skip_depth > 0:
            return
        text_node = Node(tag="__text__", text=data)
        self._current().children.append(text_node)

    def handle_entityref(self, name: str) -> None:
        from html import unescape
        if self._skip_depth > 0:
            return
        char = unescape(f"&{name};")
        text_node = Node(tag="__text__", text=char)
        self._current().children.append(text_node)

    def handle_charref(self, name: str) -> None:
        from html import unescape
        if self._skip_depth > 0:
            return
        char = unescape(f"&#{name};")
        text_node = Node(tag="__text__", text=char)
        self._current().children.append(text_node)


def parse_html(html: str) -> Node:
    builder = TreeBuilder()
    builder.feed(html)
    return builder.root
