# Phase 3: File Writer + CLI Entry Point

> **Status:** pending

## Overview

Implement file saving with safe filename generation and the CLI entry point with argparse. After this phase, the tool is fully functional end-to-end.

## Implementation

**Files:**
- Modify: `url2md.py` — add `sanitize_filename`, `save_markdown`, `main` functions
- Modify: `test_url2md.py` — tests for file writing and CLI

**What to build:**

`sanitize_filename(title: str, url: str) -> str`:
- If title is empty/whitespace, use URL hostname as fallback
- Replace special characters (`/\:*?"<>|`) with hyphens
- Collapse multiple consecutive hyphens to one
- Strip leading/trailing hyphens and whitespace
- Truncate to 100 characters
- Lowercase the result
- Append `.md` extension

`save_markdown(markdown: str, filename: str, output_dir: Path) -> Path`:
- If file already exists, append numeric suffix: `name-1.md`, `name-2.md`, etc.
- Write markdown content to file with UTF-8 encoding
- Return the final file path

`main() -> None`:
- Parse CLI args with argparse: positional `url` argument
- Call `fetch_html` → `extract_content` → `convert_to_markdown` → `clean_markdown` → `sanitize_filename` → `save_markdown`
- Print the output file path to stdout
- Exit with code 0 on success, 1 on error with error message to stderr

`pyproject.toml` entry point:
- `[project.scripts]` url2md = "url2md:main"

**What to test:**
- Sanitizes special characters in filename (EDGE-005)
- Falls back to hostname when title is empty (EDGE-004)
- Truncates long titles to 100 chars (EDGE-006)
- Appends numeric suffix for duplicate filenames (EDGE-007)
- Saves file with correct content and UTF-8 encoding (REQ-006)
- Prints file path to stdout (REQ-007)
- CLI exits 0 on success
- CLI exits 1 with usage message when no args (EDGE-008)
- CLI exits 1 with error on invalid URL (EDGE-009)
- CLI exits 1 with error on HTTP failure (EDGE-003)

**Traces to:** REQ-006, REQ-007, EDGE-004, EDGE-005, EDGE-006, EDGE-007, EDGE-008, EDGE-009

**Commit:** `feat(url2md): add file writer and CLI entry point`

## Done When

- [ ] `sanitize_filename` handles all edge cases
- [ ] `save_markdown` creates files with dedup
- [ ] `main` orchestrates the full pipeline
- [ ] CLI entry point works: `python url2md.py https://example.com`
- [ ] All tests pass
- [ ] mypy strict passes
- [ ] ruff passes

## Smoke Test

```bash
pip install -e .
url2md https://en.wikipedia.org/wiki/Markdown
# Should create a .md file and print its path
```
