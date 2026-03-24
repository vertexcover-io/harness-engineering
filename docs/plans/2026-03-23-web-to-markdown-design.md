# Web Page to Markdown Converter — Design

## Problem Statement

Build a Python CLI tool that takes a web page URL and produces a Markdown file. The HTML parsing must be implemented from scratch using only Python's stdlib (`html.parser` as the tokenizer base, no third-party parsing libraries like BeautifulSoup or lxml).

## Context

Greenfield project. No existing codebase. The constraint is educational/practical: build a pure-Python HTML-to-Markdown converter to understand parsing deeply rather than depending on external libraries.

## Requirements

### Functional Requirements

1. Accept a URL as CLI argument, fetch the page via `urllib`, output Markdown to stdout or a file
2. Build a lightweight DOM tree from `html.parser` events
3. Convert HTML elements to Markdown:
   - Headings (h1-h6) → `#` syntax
   - Paragraphs → double newline separated text
   - Links (`<a>`) → `[text](url)`
   - Images (`<img>`) → `![alt](src)`
   - Unordered lists (`<ul>/<li>`) → `- item`
   - Ordered lists (`<ol>/<li>`) → `1. item`
   - Nested lists → indented with proper markers
   - Bold (`<b>/<strong>`) → `**text**`
   - Italic (`<i>/<em>`) → `*text*`
   - Strikethrough (`<s>/<del>`) → `~~text~~`
   - Inline code (`<code>`) → `` `text` ``
   - Code blocks (`<pre><code>`) → fenced code blocks
   - Blockquotes (`<blockquote>`) → `> text`
   - Tables (`<table>`) → pipe tables
   - Horizontal rules (`<hr>`) → `---`
4. Strip `<script>`, `<style>`, `<nav>`, `<footer>`, `<header>` content
5. Decode HTML entities (`&amp;`, `&#8217;`, etc.)
6. Follow redirects (urllib handles this)

### Non-Functional Requirements

- Zero third-party dependencies — Python stdlib only
- Graceful handling of malformed HTML
- Reasonable performance on typical web pages (< 1s for most pages)
- Clean, readable output (no excessive blank lines or trailing whitespace)

### Edge Cases and Boundary Conditions

- Nested inline formatting (`<b><i>text</i></b>` → `***text***`)
- Deeply nested lists (indent 2 spaces per level)
- Tables with colspan/rowspan → degrade to simple pipe tables, ignore span attributes
- Missing charset → default to UTF-8
- Non-HTML responses → detect Content-Type, error gracefully
- Empty elements → skip (don't emit empty `**` or `[]()`)
- Self-closing/void elements (`<br>`, `<img>`, `<hr>`)
- Whitespace normalization: collapse runs of whitespace in inline context, preserve in `<pre>`

## Key Insights

1. **html.parser gives us tokenization for free** — we get start/end/data events. The real work is building a tree and walking it.
2. **Whitespace is the hardest problem** — HTML collapses whitespace; Markdown is whitespace-sensitive. The tree-walk approach lets us normalize whitespace per-context.
3. **Block vs inline context drives everything** — the converter must always know whether it's inside a block element or an inline element to emit correct Markdown.
4. **Unclosed tags are normal** — real-world HTML omits closing `</p>`, `</li>`, etc. The tree builder must handle implicit closes.

## Architectural Challenges

1. **Tree construction from SAX events**: html.parser is event-based. We build a tree by maintaining a stack of open elements and appending children. Void elements and implicit closes need special handling.
2. **Context-aware rendering**: A `<code>` inside `<pre>` becomes a fenced block; standalone `<code>` becomes backticks. The tree walker must pass context down.
3. **Whitespace normalization**: Collapse whitespace in inline context, preserve in `<pre>`. Trim leading/trailing whitespace per block element. Avoid excessive blank lines in output.
4. **Nested list indentation**: Track list depth and type (ordered/unordered) to emit correct indentation and markers.

## Approaches Considered

### Approach A: Tree-Based (Chosen)

Build a lightweight DOM tree from HTMLParser events, then walk the tree recursively to emit Markdown. Each node type has a render method that knows its Markdown equivalent.

- Handles nesting naturally via recursion
- Context (list depth, pre block, etc.) passed as parameters
- Easy to test: build tree from HTML string, assert Markdown output
- Trade-off: builds full tree in memory (fine for web pages, not for multi-GB HTML)

### Approach B: Single-Pass Streaming

Convert directly from HTMLParser events to Markdown using a state machine. No tree.

- Lower memory usage
- Much harder to handle nested structures, whitespace, and context
- Difficult to test individual conversion logic
- Rejected: complexity outweighs memory savings for web-page-sized documents

### Approach C: Two-Pass Streaming

First pass strips/normalizes, second pass converts. No full tree.

- Better than single-pass for context handling
- Still struggles with deeply nested structures
- Rejected: tree approach is simpler and sufficient

## Chosen Approach

**Tree-based (Approach A)**. Web pages fit comfortably in memory. The tree structure makes nesting, context, and whitespace handling straightforward. Testing is clean: parse HTML → assert Markdown.

## High-Level Design

```
URL → [Fetcher] → raw HTML
                      ↓
              [HTMLParser + TreeBuilder] → DOM tree
                                              ↓
                                    [MarkdownRenderer] → Markdown string
                                                              ↓
                                                    [CLI] → stdout / file
```

**Components:**

1. **Fetcher**: Uses `urllib.request` to fetch URL. Handles encoding detection from Content-Type header and meta tags. Returns decoded HTML string.

2. **Tree Builder**: Subclasses `html.parser.HTMLParser`. Maintains a node stack. On start tag: create node, push to stack. On end tag: pop stack. On data: create text node. Handles void elements, implicit closes, and entity decoding.

3. **Node Model**: Simple dataclass tree — each node has a tag, attributes dict, and children list. Text nodes are leaf nodes with content.

4. **Markdown Renderer**: Recursive tree walker. Dispatches on node tag to element-specific renderers. Passes context (list depth, pre mode, blockquote depth) through the recursion. Returns a Markdown string.

5. **CLI**: `argparse`-based. Takes URL as positional arg, optional `-o` for output file. Pipes components together.

## Open Questions

- Should we attempt to extract page title from `<title>` as an h1 if no h1 exists in body? (Lean: yes)
- Should we handle `<details>/<summary>`? (Lean: skip for v1)

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Malformed HTML crashes parser | html.parser is tolerant; tree builder handles unclosed tags via implicit close rules |
| Output quality varies across sites | Focus on well-structured pages first; handle messy HTML as edge cases |
| Encoding issues | Try Content-Type header → meta charset → UTF-8 fallback |

## Assumptions

- Pages are static HTML (no JS rendering needed)
- stdlib html.parser is allowed as the tokenization base
- Pages fit in memory (reasonable for web pages)
- UTF-8 is a safe default encoding
