# Phase 2: Markdown Renderer — Block Elements

> **Status:** pending

## Overview

Build the Markdown renderer for block-level elements: headings, paragraphs, lists (including nesting), blockquotes, code blocks, and horizontal rules. After this phase, we can convert a parsed tree of block elements into clean Markdown.

## Implementation

**Files:**
- Create: `web2md/renderer.py` — recursive tree walker that emits Markdown
- Create: `tests/test_renderer.py`

**What to build:**

`renderer.py`:
- `RenderContext` dataclass: `list_depth: int = 0`, `list_type: str = ""`, `list_index: int = 0`, `in_pre: bool = False`, `blockquote_depth: int = 0`
- `render(node: Node) -> str` — public entry point, calls `_render_node` on root's children, joins with appropriate spacing, then runs `_clean_output`
- `_render_node(node: Node, ctx: RenderContext) -> str` — dispatches on tag:
  - `h1`-`h6`: `"#" * level + " " + render_children_inline(node)`
  - `p`: `render_children_inline(node)` (block spacing handled by parent)
  - `ul`: iterate children `li`, recursing with `ctx.list_type="ul"`, `ctx.list_depth + 1`
  - `ol`: iterate children `li`, recursing with `ctx.list_type="ol"`, incrementing `ctx.list_index`
  - `li`: `"  " * (ctx.list_depth - 1) + marker + " " + content`
  - `blockquote`: render children, prefix each line with `"> " * ctx.blockquote_depth`
  - `pre`: set `ctx.in_pre = True`, render children, wrap in fenced code block (triple backticks)
  - `hr`: `"---"`
  - `br`: `"\n"`
  - `__text__`: return `node.text` (whitespace collapsed unless `ctx.in_pre`)
  - Default/unknown tags: render children (pass-through)
- `_render_children_inline(node: Node, ctx: RenderContext) -> str` — renders children, collapses whitespace
- `_clean_output(text: str) -> str` — strip trailing whitespace per line, collapse 3+ consecutive newlines to 2

**What to test:**
- Headings h1-h6 produce correct `#` levels
- Paragraphs separated by blank lines
- Unordered list items with `- ` prefix
- Ordered list items with `1. `, `2. ` prefix
- Nested lists indented by 2 spaces per level
- Mixed ordered/unordered nested lists use correct markers
- Blockquote prefixed with `> `
- Blockquote containing a list: `> - item`
- `<pre><code>` produces fenced code block
- Whitespace preserved inside pre blocks
- `<hr>` produces `---`
- `<br>` produces newline
- Unknown tags pass through (children rendered)
- Output has no trailing whitespace, no 3+ consecutive blank lines

**Traces to:** REQ-003, REQ-004, REQ-007, REQ-008, REQ-009, REQ-014, REQ-015, REQ-017, REQ-022, REQ-023, REQ-024, EDGE-002, EDGE-008, EDGE-013, EDGE-014

**Commit:** `feat(renderer): add block-level Markdown rendering`

## Done When

- [ ] All heading levels render correctly
- [ ] Lists render with correct markers and nesting
- [ ] Blockquotes work standalone and with nested content
- [ ] Code blocks preserve whitespace
- [ ] Output is clean (no trailing spaces, no excessive blank lines)
- [ ] All tests pass
