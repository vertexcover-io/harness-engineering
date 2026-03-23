# Phase 1: Node Model + Tree Builder

> **Status:** pending

## Overview

Build the foundation: a lightweight DOM node model and an HTML tree builder that subclasses `html.parser.HTMLParser`. After this phase, we can parse any HTML string into a traversable tree of nodes.

## Implementation

**Files:**
- Create: `web2md/nodes.py` — Node dataclass (tag, attrs, children, text)
- Create: `web2md/tree_builder.py` — HTMLParser subclass that builds the node tree
- Create: `web2md/__init__.py` — empty, makes it a package
- Create: `tests/test_tree_builder.py`

**What to build:**

`nodes.py`:
- `Node` dataclass with: `tag: str`, `attrs: dict[str, str]`, `children: list[Node]`, `text: str | None`
- Text nodes represented as `Node(tag="__text__", text="content")`
- Helper: `is_text_node` property

`tree_builder.py`:
- Subclass `html.parser.HTMLParser`
- Maintain a stack of open nodes; root is a synthetic `Node(tag="__root__")`
- `handle_starttag`: create node, append to current parent's children, push to stack (unless void element)
- `handle_endtag`: pop stack (with implicit close handling for `p`, `li`, `dd`, `dt`, `option`)
- `handle_data`: create text node, append to current parent's children
- `handle_entityref` / `handle_charref`: decode entity, create text node
- Void elements list: `br`, `hr`, `img`, `input`, `meta`, `link`, `area`, `base`, `col`, `embed`, `source`, `track`, `wbr`
- Strip tags list: `script`, `style`, `nav`, `footer`, `header` — skip all content inside these
- Public function: `parse_html(html: str) -> Node` that creates builder, feeds HTML, returns root

**What to test:**
- Simple HTML produces correct tree structure (parent-child relationships)
- Void elements don't push to stack (e.g., `<br>` doesn't expect `</br>`)
- Text nodes are created with correct content
- Nested elements produce correct depth
- Unclosed `<p>` tags are implicitly closed when a new block element starts
- `<script>` and `<style>` content is stripped entirely
- HTML entities (`&amp;`, `&#8217;`) are decoded to Unicode text nodes
- Empty input produces root with no children

**Traces to:** REQ-002, REQ-018, REQ-019, EDGE-007, EDGE-009, EDGE-016

**Commit:** `feat(parser): add node model and HTML tree builder`

## Done When

- [ ] `parse_html("<h1>Hello</h1>")` returns root → h1 → text("Hello")
- [ ] Void elements handled without stack corruption
- [ ] Script/style/nav/footer/header content stripped
- [ ] Entity decoding works for named and numeric entities
- [ ] Unclosed tag handling works for p, li
- [ ] All tests pass
