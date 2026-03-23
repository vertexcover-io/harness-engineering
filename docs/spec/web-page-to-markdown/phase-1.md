# Phase 1: Project Setup + HTTP Fetcher

> **Status:** pending

## Overview

Set up the Python project with pyproject.toml and implement the HTTP fetching layer. After this phase, we can fetch any URL and get back HTML content with proper error handling.

## Implementation

**Files:**
- Create: `pyproject.toml` — project config with dependencies and `url2md` entry point
- Create: `url2md.py` — `fetch_html(url: str) -> tuple[str, str]` (returns HTML content and final URL)
- Create: `test_url2md.py` — tests for fetch_html

**Dependencies to install:**
- `requests` — HTTP client
- `readability-lxml` — content extraction (installed now, used in phase 2)
- `markdownify` — HTML→markdown (installed now, used in phase 2)
- `lxml` — XML/HTML parser (dependency of readability-lxml)
- `pytest` — test framework
- `responses` — HTTP mocking for tests
- `mypy` — type checker
- `ruff` — linter

**What to build:**

`fetch_html(url: str) -> tuple[str, str]`:
- Validate URL has http/https scheme
- GET request with User-Agent header, 30s timeout, max 5 redirects
- Check Content-Type is HTML (text/html or application/xhtml+xml)
- Return (html_content, final_url) on success
- Raise descriptive errors for: invalid URL, connection failure, HTTP 4xx/5xx, non-HTML content, timeout

**What to test:**
- Successful fetch returns HTML content
- User-Agent header is sent (REQ-008)
- Timeout after 30 seconds (REQ-009, EDGE-011)
- Follows redirects (REQ-010)
- Rejects non-HTML content types (EDGE-001)
- Handles unreachable URLs (EDGE-002)
- Handles HTTP 4xx/5xx errors (EDGE-003)
- Rejects invalid URLs — no scheme, malformed (EDGE-009)
- Detects non-UTF-8 encodings (REQ-011)

**Traces to:** REQ-001, REQ-008, REQ-009, REQ-010, REQ-011, EDGE-001, EDGE-002, EDGE-003, EDGE-009, EDGE-011

**Commit:** `feat(url2md): add project setup and HTTP fetcher`

## Done When

- [ ] `pyproject.toml` defines project with all dependencies
- [ ] `fetch_html` handles all success and error cases
- [ ] All fetch-related tests pass
- [ ] mypy strict passes
- [ ] ruff passes
