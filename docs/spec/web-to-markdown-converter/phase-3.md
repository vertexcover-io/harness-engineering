# Phase 3: Markdown Renderer — Inline Elements + Tables

> **Status:** pending

## Overview

Add inline formatting (bold, italic, strikethrough, inline code, links, images) and table rendering to the Markdown renderer. After this phase, the renderer handles all content types from the spec.

## Implementation

**Files:**
- Modify: `web2md/renderer.py` — add inline element handlers and table rendering
- Modify: `tests/test_renderer.py` — add inline and table tests

**What to build:**

Add to `_render_node` dispatch:
- `b` / `strong`: `"**" + render_children_inline(node) + "**"` — skip if children produce empty string
- `i` / `em`: `"*" + render_children_inline(node) + "*"` — skip if empty
- `s` / `del`: `"~~" + render_children_inline(node) + "~~"` — skip if empty
- `code` (not inside `pre`): `` "`" + render_children_inline(node) + "`" `` — skip if empty
- `a`: `"[" + render_children_inline(node) + "](" + href + ")"` — skip if no href or empty text
- `img`: `"![" + alt + "](" + src + ")"` — skip if no src

Add table rendering:
- `table`: collect rows from `thead`/`tbody`/`tr` children
- For each `tr`: collect cells from `th`/`td`
- First row (or `th` row) becomes header
- Insert separator row: `| --- | --- |`
- Remaining rows as data
- Ignore `colspan`/`rowspan` attributes (render cell content only)

**What to test:**
- Bold: `<strong>text</strong>` → `**text**`
- Italic: `<em>text</em>` → `*text*`
- Strikethrough: `<del>text</del>` → `~~text~~`
- Inline code: `<code>x</code>` → `` `x` ``
- Links: `<a href="url">text</a>` → `[text](url)`
- Images: `<img src="url" alt="desc">` → `![desc](url)`
- Nested inline: `<b><i>text</i></b>` → `***text***`
- Link with bold: `<a href="x"><b>bold</b></a>` → `[**bold**](x)`
- Empty elements produce no output
- Image with no alt: `<img src="x">` → `![](x)`
- Simple table with header and data rows
- Table without explicit thead
- Table with colspan (ignored, content still rendered)

**Traces to:** REQ-005, REQ-006, REQ-010, REQ-011, REQ-012, REQ-013, REQ-016, EDGE-001, EDGE-003, EDGE-006, EDGE-011, EDGE-012

**Commit:** `feat(renderer): add inline formatting and table support`

## Done When

- [ ] All inline formatting renders correctly
- [ ] Empty elements skipped (no empty `**`, `[]()`, etc.)
- [ ] Nested inline formatting works (bold+italic, formatted links)
- [ ] Tables render as valid pipe tables with separator
- [ ] All tests pass
