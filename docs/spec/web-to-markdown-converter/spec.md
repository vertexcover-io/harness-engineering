# SPEC: Web Page to Markdown Converter

**Source:** docs/plans/2026-03-23-web-to-markdown-design.md
**Generated:** 2026-03-23

## Requirements

| ID | Type | Requirement | Acceptance Criterion | Priority |
|----|------|-------------|---------------------|----------|
| REQ-001 | Event-driven | When a URL is provided as a CLI argument, the system shall fetch the page via `urllib.request` and return the decoded HTML string | CLI accepts a positional URL argument; fetched HTML is a non-empty string; exit code 0 on success | Must |
| REQ-002 | Event-driven | When raw HTML is received, the system shall build a tree of nodes by subclassing `html.parser.HTMLParser` and tracking a node stack | Given valid HTML, the resulting tree has a root node with children matching the document structure | Must |
| REQ-003 | Event-driven | When a DOM tree is built, the system shall convert heading elements (h1-h6) to Markdown `#` syntax with the correct heading level | `<h1>Title</h1>` produces `# Title`; `<h3>Sub</h3>` produces `### Sub` | Must |
| REQ-004 | Event-driven | When a DOM tree is built, the system shall convert `<p>` elements to text blocks separated by double newlines | Two consecutive `<p>` tags produce two text blocks with a blank line between them | Must |
| REQ-005 | Event-driven | When a DOM tree is built, the system shall convert `<a href="url">text</a>` to `[text](url)` | `<a href="https://example.com">click</a>` produces `[click](https://example.com)` | Must |
| REQ-006 | Event-driven | When a DOM tree is built, the system shall convert `<img src="url" alt="desc">` to `![desc](url)` | `<img src="pic.png" alt="photo">` produces `![photo](pic.png)` | Must |
| REQ-007 | Event-driven | When a DOM tree is built, the system shall convert `<ul>` with `<li>` children to unordered list items prefixed with `- ` | `<ul><li>A</li><li>B</li></ul>` produces `- A\n- B` | Must |
| REQ-008 | Event-driven | When a DOM tree is built, the system shall convert `<ol>` with `<li>` children to ordered list items prefixed with `1. `, `2. `, etc. | `<ol><li>A</li><li>B</li></ol>` produces `1. A\n2. B` | Must |
| REQ-009 | Event-driven | When a list is nested inside another list, the system shall indent the nested list by 2 spaces per nesting level | A `<ul>` inside a `<li>` of another `<ul>` produces items indented by 2 spaces | Must |
| REQ-010 | Event-driven | When a DOM tree is built, the system shall convert `<b>` and `<strong>` to `**text**` | `<strong>bold</strong>` produces `**bold**` | Must |
| REQ-011 | Event-driven | When a DOM tree is built, the system shall convert `<i>` and `<em>` to `*text*` | `<em>italic</em>` produces `*italic*` | Must |
| REQ-012 | Event-driven | When a DOM tree is built, the system shall convert `<s>` and `<del>` to `~~text~~` | `<del>removed</del>` produces `~~removed~~` | Should |
| REQ-013 | Event-driven | When a DOM tree is built, the system shall convert standalone `<code>` to `` `text` `` | `<code>var</code>` produces `` `var` `` | Must |
| REQ-014 | Event-driven | When a `<code>` element is inside a `<pre>` element, the system shall render a fenced code block with triple backticks | `<pre><code>x = 1</code></pre>` produces a fenced code block containing `x = 1` | Must |
| REQ-015 | Event-driven | When a DOM tree is built, the system shall convert `<blockquote>` to lines prefixed with `> ` | `<blockquote>Quote</blockquote>` produces `> Quote` | Must |
| REQ-016 | Event-driven | When a DOM tree is built, the system shall convert `<table>` to pipe-delimited Markdown tables with a header separator row | A table with `<th>` and `<td>` cells produces a valid pipe table with `|---|` separator | Must |
| REQ-017 | Event-driven | When a DOM tree is built, the system shall convert `<hr>` to `---` | `<hr>` produces `---` on its own line | Must |
| REQ-018 | Ubiquitous | The system shall strip all content within `<script>`, `<style>`, `<nav>`, `<footer>`, and `<header>` tags | Given HTML containing `<script>alert(1)</script>`, the output contains no trace of the script content | Must |
| REQ-019 | Ubiquitous | The system shall decode all HTML entities to their Unicode equivalents | `&amp;` becomes `&`; `&#8217;` becomes `'`; `&lt;` becomes `<` | Must |
| REQ-020 | Ubiquitous | The system shall use zero third-party dependencies — only Python stdlib modules | `pip freeze` in the project venv shows no installed packages; imports are limited to stdlib | Must |
| REQ-021 | Event-driven | When the `-o` flag is provided with a file path, the system shall write the Markdown output to that file instead of stdout | `web2md https://example.com -o out.md` creates `out.md` with the Markdown content | Must |
| REQ-022 | Ubiquitous | The system shall collapse runs of whitespace into a single space in inline contexts and preserve whitespace inside `<pre>` blocks | Inline text with multiple spaces becomes single-spaced; `<pre>` content retains exact whitespace | Must |
| REQ-023 | Ubiquitous | The system shall produce clean output with no more than 2 consecutive blank lines and no trailing whitespace on any line | Output passes a check: no line ends with spaces/tabs; no 3+ consecutive blank lines | Should |
| REQ-024 | Event-driven | When a `<br>` element is encountered, the system shall insert a newline in the output | `Line1<br>Line2` produces `Line1\nLine2` | Must |
| REQ-025 | Event-driven | When fetching a URL, the system shall detect encoding from the Content-Type header, then from `<meta charset>`, falling back to UTF-8 | A page served as `charset=iso-8859-1` is decoded correctly; a page with no charset declaration defaults to UTF-8 | Must |

## Edge Cases

| ID | Scenario | Expected Behavior | Derived From |
|----|----------|-------------------|-------------|
| EDGE-001 | Nested inline formatting: `<b><i>text</i></b>` | Produces `***text***` | REQ-010, REQ-011 |
| EDGE-002 | Deeply nested list (3+ levels) | Each level indented by 2 additional spaces with correct markers | REQ-009 |
| EDGE-003 | Table with colspan/rowspan attributes | Renders as a simple pipe table ignoring span attributes; no crash | REQ-016 |
| EDGE-004 | Missing charset in response headers and HTML | Defaults to UTF-8 decoding without error | REQ-025 |
| EDGE-005 | Non-HTML Content-Type (e.g., `application/pdf`) | Prints an error message to stderr and exits with non-zero code | REQ-001 |
| EDGE-006 | Empty inline elements: `<b></b>`, `<a href="x"></a>` | Produces no output (no empty `**` or `[]()`) | REQ-010, REQ-005 |
| EDGE-007 | Self-closing/void elements: `<br/>`, `<img/>`, `<hr/>` | Handled correctly without crashing or leaving unclosed nodes | REQ-024, REQ-006, REQ-017 |
| EDGE-008 | Whitespace inside `<pre>` blocks with indentation | Whitespace preserved exactly as written in source HTML | REQ-022 |
| EDGE-009 | Unclosed tags: `<p>First<p>Second` | Tree builder implicitly closes first `<p>` before opening second; both paragraphs render | REQ-002, REQ-004 |
| EDGE-010 | URL returns HTTP redirect (301/302) | urllib follows the redirect; final page content is converted | REQ-001 |
| EDGE-011 | Image with no alt attribute | Produces `![](src)` with empty alt text | REQ-006 |
| EDGE-012 | Link with nested inline formatting: `<a href="x"><b>bold link</b></a>` | Produces `[**bold link**](x)` | REQ-005, REQ-010 |
| EDGE-013 | Blockquote containing a list | List items inside blockquote are prefixed with `> - item` | REQ-015, REQ-007 |
| EDGE-014 | Mixed ordered and unordered nested lists | Each list level uses the correct marker type (`-` vs `1.`) | REQ-007, REQ-008, REQ-009 |
| EDGE-015 | Invalid URL (non-existent domain) | Prints an error message to stderr and exits with non-zero code | REQ-001 |
| EDGE-016 | HTML with only `<script>` and `<style>` content (no body text) | Produces empty or minimal Markdown output without error | REQ-018 |

## Verification Matrix

| REQ ID | Unit Test | Integration Test | Manual Test | Notes |
|--------|-----------|-----------------|-------------|-------|
| REQ-001 | Yes | Yes | No | Unit: mock urllib; Integration: fetch real URL |
| REQ-002 | Yes | No | No | Parse HTML string, assert tree structure |
| REQ-003 | Yes | No | No | h1-h6 conversion |
| REQ-004 | Yes | No | No | Paragraph separation |
| REQ-005 | Yes | No | No | Link conversion |
| REQ-006 | Yes | No | No | Image conversion |
| REQ-007 | Yes | No | No | Unordered list |
| REQ-008 | Yes | No | No | Ordered list |
| REQ-009 | Yes | No | No | Nested list indentation |
| REQ-010 | Yes | No | No | Bold conversion |
| REQ-011 | Yes | No | No | Italic conversion |
| REQ-012 | Yes | No | No | Strikethrough conversion |
| REQ-013 | Yes | No | No | Inline code |
| REQ-014 | Yes | No | No | Fenced code block |
| REQ-015 | Yes | No | No | Blockquote conversion |
| REQ-016 | Yes | No | No | Table conversion |
| REQ-017 | Yes | No | No | Horizontal rule |
| REQ-018 | Yes | No | No | Script/style/nav stripping |
| REQ-019 | Yes | No | No | Entity decoding |
| REQ-020 | No | No | Yes | Verify imports manually |
| REQ-021 | Yes | No | No | File output flag |
| REQ-022 | Yes | No | No | Whitespace normalization |
| REQ-023 | Yes | No | No | Clean output check |
| REQ-024 | Yes | No | No | `<br>` handling |
| REQ-025 | Yes | Yes | No | Unit: mock responses; Integration: real pages with encoding |
| EDGE-001 | Yes | No | No | Nested bold+italic |
| EDGE-002 | Yes | No | No | 3+ level nesting |
| EDGE-003 | Yes | No | No | colspan/rowspan ignored |
| EDGE-004 | Yes | No | No | Missing charset fallback |
| EDGE-005 | Yes | No | No | Non-HTML content type |
| EDGE-006 | Yes | No | No | Empty elements skipped |
| EDGE-007 | Yes | No | No | Void elements |
| EDGE-008 | Yes | No | No | Pre whitespace preservation |
| EDGE-009 | Yes | No | No | Unclosed tags |
| EDGE-010 | No | Yes | No | Redirect following |
| EDGE-011 | Yes | No | No | Missing alt attribute |
| EDGE-012 | Yes | No | No | Formatted link text |
| EDGE-013 | Yes | No | No | Blockquote + list |
| EDGE-014 | Yes | No | No | Mixed list types nested |
| EDGE-015 | Yes | No | No | Invalid URL error handling |
| EDGE-016 | Yes | No | No | Script-only page |

## Out of Scope

- JavaScript rendering (SPA content extraction)
- `<details>/<summary>` elements
- `<iframe>` content extraction
- Form elements (`<input>`, `<select>`, `<textarea>`)
- CSS-driven layout or visibility (hidden elements)
- Multi-page crawling or link following
- PDF, image, or other non-HTML content conversion
- Custom Markdown flavors (only standard + GFM tables/strikethrough)
- Relative URL resolution for links and images
