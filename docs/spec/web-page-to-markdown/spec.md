# SPEC: Web Page to Markdown Converter

**Source:** docs/plans/2026-03-23-web-page-to-markdown-design.md
**Generated:** 2026-03-23

## Requirements

| ID | Type | Requirement | Acceptance Criterion | Priority |
|----|------|-------------|---------------------|----------|
| REQ-001 | Event-driven | When a URL is provided as a CLI argument, the system shall fetch the page HTML via HTTP GET | HTTP response body is retrieved; exit code 0 on success | Must |
| REQ-002 | Event-driven | When raw HTML is fetched, the system shall extract the main content using the readability algorithm | Output contains article body; navigation, footer, sidebar, and ads are excluded | Must |
| REQ-003 | Unwanted | If readability extraction fails to identify main content, then the system shall fall back to the full `<body>` content | Fallback produces non-empty markdown from the body element | Must |
| REQ-004 | Event-driven | When main content HTML is extracted, the system shall convert it to markdown preserving headings, links, images, lists, code blocks, and tables | Each HTML element type maps to its markdown equivalent | Must |
| REQ-005 | Event-driven | When markdown is generated, the system shall post-process it to collapse excessive whitespace, remove empty headings, and strip leftover HTML tags | Output contains no runs of 3+ blank lines, no empty headings, no raw HTML tags | Must |
| REQ-006 | Event-driven | When conversion completes, the system shall save the markdown to a `.md` file named from the sanitized page title | File is created in the current directory with a filesystem-safe name | Must |
| REQ-007 | Event-driven | When the file is saved, the system shall print the output file path to stdout | Stdout contains exactly the file path on a single line | Must |
| REQ-008 | Ubiquitous | The system shall send a User-Agent header with HTTP requests | Request headers include a non-empty User-Agent string | Must |
| REQ-009 | Ubiquitous | The system shall enforce a 30-second timeout on HTTP requests | Requests exceeding 30 seconds result in a timeout error, not a hang | Should |
| REQ-010 | Ubiquitous | The system shall follow HTTP redirects up to 5 hops | Redirected URLs resolve to final content; redirect loops produce an error | Should |
| REQ-011 | Ubiquitous | The system shall detect and handle non-UTF-8 page encodings | Pages with ISO-8859-1, Windows-1252, etc. produce correct unicode markdown | Should |

## Edge Cases

| ID | Scenario | Expected Behavior | Derived From |
|----|----------|-------------------|-------------|
| EDGE-001 | URL returns non-HTML content type (PDF, image, JSON) | Exit with non-zero code and error message: "Error: URL returned non-HTML content type: <type>" | REQ-001 |
| EDGE-002 | URL is unreachable (DNS failure, connection refused) | Exit with non-zero code and error message containing the network error | REQ-001 |
| EDGE-003 | HTTP response is 4xx or 5xx | Exit with non-zero code and error message: "Error: HTTP <status_code>" | REQ-001 |
| EDGE-004 | Page title is empty or missing | Use the URL hostname as the filename fallback | REQ-006 |
| EDGE-005 | Page title contains special characters (`/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `\|`) | Special characters are replaced with hyphens in the filename | REQ-006 |
| EDGE-006 | Page title exceeds 100 characters | Filename is truncated to 100 characters (before `.md` extension) | REQ-006 |
| EDGE-007 | Output filename already exists in current directory | A numeric suffix is appended: `title-1.md`, `title-2.md`, etc. | REQ-006 |
| EDGE-008 | No CLI argument provided | Exit with non-zero code and usage message showing expected syntax | REQ-001 |
| EDGE-009 | CLI argument is not a valid URL (no scheme, malformed) | Exit with non-zero code and error message: "Error: Invalid URL" | REQ-001 |
| EDGE-010 | Page has no `<body>` element (malformed HTML) | Exit with non-zero code and error message: "Error: No content found" | REQ-003 |
| EDGE-011 | HTTP request times out after 30 seconds | Exit with non-zero code and error message: "Error: Request timed out" | REQ-009 |

## Verification Matrix

| REQ ID | Unit Test | Integration Test | Manual Test | Notes |
|--------|-----------|-----------------|-------------|-------|
| REQ-001 | Yes | Yes | No | Integration test hits a real URL or local server |
| REQ-002 | Yes | No | No | Test with sample HTML containing nav/footer/article |
| REQ-003 | Yes | No | No | Test with HTML that has no article-like structure |
| REQ-004 | Yes | No | No | Test each element type: h1-h6, a, img, ul/ol, pre/code, table |
| REQ-005 | Yes | No | No | Test with markdown containing excessive whitespace and empty headings |
| REQ-006 | Yes | No | No | Test filename generation from various titles |
| REQ-007 | Yes | No | No | Capture stdout and verify path |
| REQ-008 | Yes | No | No | Mock requests and inspect headers |
| REQ-009 | Yes | No | No | Mock a slow response |
| REQ-010 | Yes | No | No | Mock redirect chain |
| REQ-011 | Yes | No | No | Test with ISO-8859-1 encoded content |
| EDGE-001 | Yes | No | No | Mock response with content-type: application/pdf |
| EDGE-002 | Yes | No | No | Mock ConnectionError |
| EDGE-003 | Yes | No | No | Mock 404 and 500 responses |
| EDGE-004 | Yes | No | No | HTML with empty `<title>` |
| EDGE-005 | Yes | No | No | Title with each special character |
| EDGE-006 | Yes | No | No | Title with 200+ characters |
| EDGE-007 | Yes | No | No | Create existing file, verify suffix |
| EDGE-008 | Yes | No | No | Run CLI with no args |
| EDGE-009 | Yes | No | No | Pass "not-a-url" as argument |
| EDGE-010 | Yes | No | No | HTML with no body element |
| EDGE-011 | Yes | No | No | Mock timeout exception |

## Out of Scope

- JavaScript-rendered content (SPAs, React apps)
- Authentication or cookie-based session handling
- Bypassing anti-bot measures or CAPTCHAs
- Batch processing of multiple URLs
- Custom output directory selection (always saves to current directory)
- Configurable extraction rules or CSS selectors
- Image downloading or embedding
- PDF or non-HTML document conversion
