# url2md

Convert web pages to clean markdown files.

## What it does

A Python CLI tool that fetches any web page, extracts the main content using Mozilla's Readability algorithm, converts it to markdown, and saves it as a `.md` file.

## Installation

Requires Python 3.10+.

```bash
pip install .
```

## Usage

```bash
url2md https://example.com/article
```

This will:
1. Fetch the page HTML
2. Extract the main content (stripping navigation, footers, sidebars)
3. Convert to clean markdown
4. Save to a file named from the page title (e.g., `my-article.md`)
5. Print the output file path to stdout

## How it works

| Stage | Description |
|---|---|
| Fetch | HTTP GET with User-Agent header, 30s timeout, up to 5 redirects |
| Extract | Readability algorithm isolates main content; falls back to `<body>` if extraction fails |
| Convert | HTML to markdown via markdownify (ATX headings, links, images, lists, code blocks, tables) |
| Clean | Collapse excessive whitespace, remove empty headings, strip leftover HTML tags |
| Save | Sanitized filename from page title, `.md` extension, numeric suffix on duplicates |

## Error handling

- Invalid/malformed URLs: `Error: Invalid URL`
- Non-HTML content types: `Error: URL returned non-HTML content type: <type>`
- HTTP errors: `Error: HTTP <status_code>`
- Unreachable hosts: `Error: <network error details>`
- Timeout: `Error: Request timed out`
- No body element: raises `ValueError("No content found")`

All errors exit with code 1.

## Project structure

```
url2md.py          # All logic: fetch, extract, convert, clean, save, CLI
test_url2md.py     # 47 tests covering all requirements and edge cases
pyproject.toml     # Dependencies, entry point, tool config
```

## Dependencies

- `requests` -- HTTP fetching
- `readability-lxml` -- Content extraction (Mozilla Readability port)
- `markdownify` -- HTML to markdown conversion
- `lxml` -- HTML parsing

## Development

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

pytest test_url2md.py -v    # Run tests
mypy --strict url2md.py     # Type check
ruff check url2md.py        # Lint
```

## Out of scope

- JavaScript-rendered content (SPAs, React apps)
- Authentication or cookie-based sessions
- Anti-bot bypass or CAPTCHAs
- Batch processing of multiple URLs
- Custom output directory
- Image downloading or embedding

## License

MIT
