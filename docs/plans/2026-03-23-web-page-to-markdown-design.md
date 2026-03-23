# Web Page to Markdown Converter — Design

## Problem Statement
Users need a CLI tool to convert any web page URL into a clean markdown file, extracting only the main content and saving it automatically.

## Context
Greenfield project. No existing code. The tool lives in this repository as a standalone Python CLI utility.

## Requirements

### Functional Requirements
1. Accept a URL as a CLI argument
2. Fetch the page HTML via HTTP (static fetch, no JS rendering)
3. Extract main content using readability algorithm (strip nav, footer, sidebar, ads)
4. Convert extracted HTML to clean markdown (headings, links, images, lists, code blocks, tables)
5. Auto-save to a `.md` file named from the sanitized page title
6. Print the output file path to stdout after saving

### Non-Functional Requirements
- Fast execution (no browser, pure HTTP fetch)
- Handle HTTP redirects, timeouts, and encoding detection
- Produce clean, readable markdown (no artifacts or leftover HTML)
- Minimal dependencies
- Python 3.10+ with strict type hints

### Edge Cases and Boundary Conditions
- Pages with no discernible main content (fallback to full body)
- Non-HTML responses (PDF, image) — reject with clear error
- Pages behind auth or paywalls — report HTTP status clearly
- Non-UTF-8 encodings — detect and decode properly
- Extremely long page titles — truncate filename to reasonable length
- Duplicate filenames — append a numeric suffix
- Invalid/unreachable URLs — clear error message with status

## Key Insights
- Mozilla's Readability algorithm (ported to Python as `readability-lxml`) is the gold standard for content extraction — same engine Firefox Reader View uses.
- `markdownify` handles HTML→Markdown conversion well, including nested structures, links, images, and code blocks.
- Content extraction quality matters more than conversion fidelity — garbage in, garbage out.

## Architectural Challenges
- **Content extraction quality:** Readability works well on article-style pages but may struggle with unconventional layouts. Fallback to full `<body>` when readability confidence is low.
- **Markdown cleanliness:** Raw conversion often produces excessive whitespace, empty links, or broken formatting. Post-processing cleanup is needed.
- **Filename safety:** Page titles can contain any unicode, special characters, or be very long. Need robust sanitization.

## Approaches Considered

### Approach A: requests + readability-lxml + markdownify
Fetch with `requests`, extract main content with `readability-lxml`, convert to markdown with `markdownify`. Each library does one thing well.

### Approach B: requests + BeautifulSoup + custom extraction
Manual heuristics for content extraction using BeautifulSoup. More control but significantly more code and maintenance.

### Approach C: trafilatura
All-in-one extraction library. Good at content extraction but limited markdown formatting control.

## Chosen Approach
**Approach A: requests + readability-lxml + markdownify.** Each component is proven, focused, and composable. readability-lxml is a direct port of Mozilla's algorithm. markdownify gives us control over conversion options.

## High-Level Design

```
URL → [HTTP Fetch] → raw HTML
    → [Readability Extract] → clean HTML (main content + title)
    → [Markdownify Convert] → raw markdown
    → [Post-Process Cleanup] → clean markdown
    → [File Writer] → saved .md file
```

Components:
1. **Fetcher:** Uses `requests` to GET the URL with proper headers (User-Agent), timeout, redirect handling, and encoding detection.
2. **Extractor:** Uses `readability-lxml` to extract main content HTML and page title. Falls back to `<body>` if extraction fails.
3. **Converter:** Uses `markdownify` to convert clean HTML to markdown with configured options (heading style, link handling, image alt text).
4. **Cleaner:** Post-processes markdown to collapse excessive whitespace, fix broken links, remove empty headings.
5. **Writer:** Sanitizes title for filename, checks for duplicates, writes `.md` file to current directory.
6. **CLI:** `argparse`-based entry point accepting URL argument.

## Open Questions
None — scope is well-defined.

## Risks and Mitigations
- **Readability fails on non-article pages:** Mitigated by fallback to full body extraction.
- **Some sites block automated requests:** Mitigated by setting a reasonable User-Agent header. Not in scope to bypass anti-bot measures.

## Assumptions
- Python 3.10+ available
- Internet access available at runtime
- Target pages serve static HTML (JS-rendered content out of scope)
