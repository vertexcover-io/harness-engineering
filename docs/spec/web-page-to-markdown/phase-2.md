# Phase 2: Content Extraction + Markdown Conversion

> **Status:** pending

## Overview

Implement the core pipeline: extract main content from HTML using readability, convert to markdown, and clean up the output. After this phase, we can turn raw HTML into clean markdown.

## Implementation

**Files:**
- Modify: `url2md.py` — add `extract_content`, `convert_to_markdown`, `clean_markdown` functions
- Modify: `test_url2md.py` — tests for extraction, conversion, and cleanup

**What to build:**

`extract_content(html: str) -> tuple[str, str]`:
- Use `readability-lxml` Document to extract main content HTML and title
- If readability returns empty/minimal content, fall back to full `<body>`
- If no `<body>` exists, raise error "No content found"
- Return (content_html, title)

`convert_to_markdown(html: str) -> str`:
- Use `markdownify.markdownify()` with options:
  - `heading_style="ATX"` (# style headings)
  - `strip=["script", "style"]`
- Preserve: headings (h1-h6), links (a), images (img), lists (ul/ol/li), code blocks (pre/code), tables

`clean_markdown(md: str) -> str`:
- Collapse 3+ consecutive blank lines to 2
- Remove empty headings (lines that are just `#` with no text)
- Strip any remaining HTML tags
- Trim leading/trailing whitespace

**What to test:**
- Extracts article content, excludes nav/footer/sidebar (REQ-002)
- Falls back to body when readability fails (REQ-003)
- Errors on HTML with no body element (EDGE-010)
- Extracts page title correctly (REQ-006 prereq)
- Empty title falls back correctly (EDGE-004 prereq)
- Converts headings h1-h6 to ATX markdown (REQ-004)
- Converts links with href and text (REQ-004)
- Converts images with alt text (REQ-004)
- Converts ordered and unordered lists (REQ-004)
- Converts code blocks (REQ-004)
- Converts tables (REQ-004)
- Collapses excessive whitespace (REQ-005)
- Removes empty headings (REQ-005)
- Strips leftover HTML tags (REQ-005)

**Traces to:** REQ-002, REQ-003, REQ-004, REQ-005, EDGE-004 (title part), EDGE-010

**Commit:** `feat(url2md): add content extraction and markdown conversion`

## Done When

- [ ] `extract_content` extracts main content and title from HTML
- [ ] `convert_to_markdown` handles all element types
- [ ] `clean_markdown` produces artifact-free output
- [ ] All extraction/conversion tests pass
- [ ] mypy strict passes
- [ ] ruff passes
