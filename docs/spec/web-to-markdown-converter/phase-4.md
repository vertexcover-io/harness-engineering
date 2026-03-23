# Phase 4: Fetcher + CLI

> **Status:** pending

## Overview

Add the HTTP fetcher (urllib-based with encoding detection) and the CLI entry point. After this phase, the tool is fully functional end-to-end: URL in, Markdown out.

## Implementation

**Files:**
- Create: `web2md/fetcher.py` — URL fetching with encoding detection
- Create: `web2md/cli.py` — argparse-based CLI
- Create: `web2md/__main__.py` — `python -m web2md` entry point
- Create: `tests/test_fetcher.py`
- Create: `tests/test_cli.py`
- Create: `pyproject.toml` — project metadata, pytest config, mypy config

**What to build:**

`fetcher.py`:
- `fetch_url(url: str) -> str` — fetches URL, returns decoded HTML
- Use `urllib.request.urlopen` with a reasonable timeout (10s)
- Encoding detection order: Content-Type header `charset=` → `<meta charset="...">` in first 1024 bytes → UTF-8 fallback
- Validate Content-Type starts with `text/html` — raise `ValueError` for non-HTML
- Raise `FetchError(message: str)` custom exception for network/HTTP errors

`cli.py`:
- `def main() -> None` — entry point
- `argparse`: positional `url`, optional `-o`/`--output` for file path
- Pipeline: `fetch_url(url)` → `parse_html(html)` → `render(tree)` → stdout or file
- Error handling: catch `FetchError`, `ValueError`, print to stderr, exit 1

`__main__.py`:
- `from web2md.cli import main; main()`

`pyproject.toml`:
- `[project]` with name, version, python-requires
- `[project.scripts]` entry point: `web2md = "web2md.cli:main"`
- `[tool.pytest.ini_options]` testpaths
- `[tool.mypy]` strict mode

**What to test:**

`test_fetcher.py` (mock urllib):
- Successful fetch returns decoded HTML string
- Encoding from Content-Type header used correctly
- Missing charset falls back to UTF-8
- Non-HTML Content-Type raises ValueError
- Network error raises FetchError
- HTTP error (404, 500) raises FetchError

`test_cli.py` (mock fetcher, capture stdout):
- URL argument produces Markdown on stdout
- `-o` flag writes to file
- Non-HTML URL prints error to stderr, exits 1
- Invalid URL prints error to stderr, exits 1

**Traces to:** REQ-001, REQ-020, REQ-021, REQ-025, EDGE-004, EDGE-005, EDGE-010, EDGE-015

**Commit:** `feat(cli): add URL fetcher and CLI entry point`

## Done When

- [ ] `python -m web2md https://example.com` outputs Markdown
- [ ] `-o` flag writes to file
- [ ] Encoding detection works (Content-Type → meta → UTF-8)
- [ ] Non-HTML and invalid URLs produce clear error messages
- [ ] pyproject.toml configured with mypy strict and pytest
- [ ] All tests pass
- [ ] `mypy web2md/` passes
