import re
import subprocess
from io import StringIO
from pathlib import Path

import pytest
import responses

from url2md import (
    clean_markdown,
    convert_to_markdown,
    extract_content,
    fetch_html,
    main,
    sanitize_filename,
    save_markdown,
)

SAMPLE_HTML = "<html><head><title>Test</title></head><body><p>Hello</p></body></html>"


@responses.activate
def test_fetch_html_returns_content_and_final_url() -> None:
    """REQ-001: Fetch HTML from URL."""
    responses.add(
        responses.GET,
        "https://example.com",
        body=SAMPLE_HTML,
        content_type="text/html; charset=utf-8",
    )
    html, final_url = fetch_html("https://example.com")
    assert "Hello" in html
    assert final_url == "https://example.com/"


@responses.activate
def test_fetch_html_sends_user_agent_header() -> None:
    """REQ-008: Send User-Agent header."""
    responses.add(
        responses.GET,
        "https://example.com",
        body=SAMPLE_HTML,
        content_type="text/html",
    )
    fetch_html("https://example.com")
    assert responses.calls[0].request.headers.get("User-Agent")
    assert "url2md" in responses.calls[0].request.headers["User-Agent"].lower()


@responses.activate
def test_fetch_html_timeout() -> None:
    """REQ-009 / EDGE-011: 30-second timeout."""
    import requests as req_lib

    responses.add(
        responses.GET,
        "https://example.com",
        body=req_lib.exceptions.ReadTimeout("timeout"),
    )
    with pytest.raises(SystemExit) as exc_info:
        fetch_html("https://example.com")
    assert exc_info.value.code != 0
    # Error message captured via capsys would show "Request timed out"


@responses.activate
def test_fetch_html_timeout_error_message(capsys: pytest.CaptureFixture[str]) -> None:
    """EDGE-011: Timeout error message."""
    import requests as req_lib

    responses.add(
        responses.GET,
        "https://example.com",
        body=req_lib.exceptions.ReadTimeout("timeout"),
    )
    with pytest.raises(SystemExit):
        fetch_html("https://example.com")
    captured = capsys.readouterr()
    assert "Error: Request timed out" in captured.err


@responses.activate
def test_fetch_html_follows_redirects() -> None:
    """REQ-010: Follow redirects up to 5 hops."""
    responses.add(
        responses.GET,
        "https://old.example.com/",
        status=301,
        headers={"Location": "https://new.example.com/"},
    )
    responses.add(
        responses.GET,
        "https://new.example.com/",
        body=SAMPLE_HTML,
        content_type="text/html",
    )
    html, final_url = fetch_html("https://old.example.com")
    assert "Hello" in html
    assert "new.example.com" in final_url


@responses.activate
def test_fetch_html_rejects_non_html_content_type(capsys: pytest.CaptureFixture[str]) -> None:
    """EDGE-001: Reject non-HTML content types."""
    responses.add(
        responses.GET,
        "https://example.com/file.pdf",
        body=b"%PDF-1.4",
        content_type="application/pdf",
    )
    with pytest.raises(SystemExit) as exc_info:
        fetch_html("https://example.com/file.pdf")
    assert exc_info.value.code != 0
    captured = capsys.readouterr()
    assert "Error: URL returned non-HTML content type: application/pdf" in captured.err


@responses.activate
def test_fetch_html_handles_unreachable_url(capsys: pytest.CaptureFixture[str]) -> None:
    """EDGE-002: Handle unreachable URLs."""
    import requests as req_lib

    responses.add(
        responses.GET,
        "https://unreachable.example.com",
        body=req_lib.exceptions.ConnectionError("DNS failure"),
    )
    with pytest.raises(SystemExit) as exc_info:
        fetch_html("https://unreachable.example.com")
    assert exc_info.value.code != 0
    captured = capsys.readouterr()
    assert "Error:" in captured.err


@responses.activate
def test_fetch_html_handles_http_404(capsys: pytest.CaptureFixture[str]) -> None:
    """EDGE-003: Handle HTTP 4xx."""
    responses.add(
        responses.GET,
        "https://example.com/missing",
        status=404,
    )
    with pytest.raises(SystemExit) as exc_info:
        fetch_html("https://example.com/missing")
    assert exc_info.value.code != 0
    captured = capsys.readouterr()
    assert "Error: HTTP 404" in captured.err


@responses.activate
def test_fetch_html_handles_http_500(capsys: pytest.CaptureFixture[str]) -> None:
    """EDGE-003: Handle HTTP 5xx."""
    responses.add(
        responses.GET,
        "https://example.com/error",
        status=500,
    )
    with pytest.raises(SystemExit) as exc_info:
        fetch_html("https://example.com/error")
    assert exc_info.value.code != 0
    captured = capsys.readouterr()
    assert "Error: HTTP 500" in captured.err


def test_fetch_html_rejects_invalid_url_no_scheme(capsys: pytest.CaptureFixture[str]) -> None:
    """EDGE-009: Reject invalid URLs (no scheme)."""
    with pytest.raises(SystemExit) as exc_info:
        fetch_html("example.com")
    assert exc_info.value.code != 0
    captured = capsys.readouterr()
    assert "Error: Invalid URL" in captured.err


def test_fetch_html_rejects_invalid_url_malformed(capsys: pytest.CaptureFixture[str]) -> None:
    """EDGE-009: Reject malformed URLs."""
    with pytest.raises(SystemExit) as exc_info:
        fetch_html("not-a-url")
    assert exc_info.value.code != 0
    captured = capsys.readouterr()
    assert "Error: Invalid URL" in captured.err


def test_fetch_html_rejects_ftp_scheme(capsys: pytest.CaptureFixture[str]) -> None:
    """EDGE-009: Reject non-http schemes."""
    with pytest.raises(SystemExit) as exc_info:
        fetch_html("ftp://example.com")
    assert exc_info.value.code != 0
    captured = capsys.readouterr()
    assert "Error: Invalid URL" in captured.err


@responses.activate
def test_fetch_html_handles_non_utf8_encoding() -> None:
    """REQ-011: Handle non-UTF-8 encodings."""
    latin1_html = '<html><head><meta charset="iso-8859-1"><title>Test</title></head><body><p>café</p></body></html>'
    responses.add(
        responses.GET,
        "https://example.com",
        body=latin1_html.encode("iso-8859-1"),
        content_type="text/html; charset=iso-8859-1",
    )
    html, _ = fetch_html("https://example.com")
    assert "café" in html


@responses.activate
def test_fetch_html_accepts_xhtml_content_type() -> None:
    """REQ-001: Accept application/xhtml+xml."""
    responses.add(
        responses.GET,
        "https://example.com",
        body=SAMPLE_HTML,
        content_type="application/xhtml+xml",
    )
    html, _ = fetch_html("https://example.com")
    assert "Hello" in html


# --- Phase 2: extract_content tests ---

ARTICLE_HTML = """
<html><head><title>My Article</title></head><body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<article><h1>Main Heading</h1>
<p>This is the main article content with enough text to be recognized by
readability as the primary content. It needs to be sufficiently long to pass
the readability heuristics. Adding more sentences here to ensure the content
is substantial enough for the algorithm to identify it as the main article
body rather than boilerplate navigation or sidebar content.</p>
<p>Paragraph two continues the article with additional information about the
topic at hand. The readability algorithm looks for dense content regions and
this paragraph helps establish the article as the dominant content block.</p>
<p>A third paragraph further reinforces the article content. By having multiple
paragraphs with substantive text, the readability algorithm can confidently
identify this section as the primary content of the page.</p>
<p>The fourth paragraph drives the point home. Readability uses a scoring
system that rewards longer text blocks within semantic HTML elements like
article tags. This helps it distinguish real content from navigation.</p>
</article>
<footer><p>Copyright 2026</p></footer>
<aside><p>Sidebar stuff</p></aside>
</body></html>
"""

MINIMAL_HTML = """
<html><head><title>Simple</title></head><body>
<p>Just a paragraph with no article structure whatsoever.</p>
</body></html>
"""

NO_BODY_HTML = "<html><head><title>No Body</title></head></html>"


def test_extract_content_excludes_nav_footer_sidebar() -> None:
    """REQ-002: Extract main content, exclude nav/footer/sidebar."""
    content, title = extract_content(ARTICLE_HTML)
    assert "Main Heading" in content or "main article content" in content
    assert "Home" not in content or "About" not in content
    assert "Copyright" not in content
    assert "Sidebar" not in content


def test_extract_content_falls_back_to_body() -> None:
    """REQ-003: Fall back to body when readability fails."""
    content, title = extract_content(MINIMAL_HTML)
    assert "Just a paragraph" in content


def test_extract_content_raises_on_no_body() -> None:
    """EDGE-010: Error on HTML with no body element."""
    with pytest.raises(ValueError, match="No content found"):
        extract_content(NO_BODY_HTML)


def test_extract_content_returns_title() -> None:
    """REQ-006 prereq: Extract page title."""
    _, title = extract_content(ARTICLE_HTML)
    assert "My Article" in title


def test_extract_content_empty_title() -> None:
    """EDGE-004 prereq: Empty title falls back correctly."""
    html = "<html><head><title></title></head><body><p>Content</p></body></html>"
    _, title = extract_content(html)
    assert title == ""


# --- Phase 2: convert_to_markdown tests ---


def test_convert_headings_to_atx() -> None:
    """REQ-004: Convert headings h1-h6 to ATX markdown."""
    html = "<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>"
    md = convert_to_markdown(html)
    assert "# One" in md
    assert "## Two" in md
    assert "### Three" in md
    assert "#### Four" in md
    assert "##### Five" in md
    assert "###### Six" in md


def test_convert_links() -> None:
    """REQ-004: Convert links with href and text."""
    html = '<a href="https://example.com">Click here</a>'
    md = convert_to_markdown(html)
    assert "[Click here](https://example.com)" in md


def test_convert_images() -> None:
    """REQ-004: Convert images with alt text."""
    html = '<img src="photo.jpg" alt="A photo">'
    md = convert_to_markdown(html)
    assert "![A photo](photo.jpg)" in md


def test_convert_unordered_list() -> None:
    """REQ-004: Convert unordered lists."""
    html = "<ul><li>Alpha</li><li>Beta</li></ul>"
    md = convert_to_markdown(html)
    assert "* Alpha" in md or "- Alpha" in md
    assert "* Beta" in md or "- Beta" in md


def test_convert_ordered_list() -> None:
    """REQ-004: Convert ordered lists."""
    html = "<ol><li>First</li><li>Second</li></ol>"
    md = convert_to_markdown(html)
    assert "1." in md
    assert "First" in md
    assert "Second" in md


def test_convert_code_blocks() -> None:
    """REQ-004: Convert code blocks."""
    html = "<pre><code>x = 1</code></pre>"
    md = convert_to_markdown(html)
    assert "x = 1" in md
    assert "```" in md or "    x = 1" in md


def test_convert_tables() -> None:
    """REQ-004: Convert tables."""
    html = "<table><tr><th>Name</th><th>Age</th></tr><tr><td>Alice</td><td>30</td></tr></table>"
    md = convert_to_markdown(html)
    assert "Name" in md
    assert "Alice" in md
    assert "|" in md


def test_convert_strips_script_and_style() -> None:
    """REQ-004: Scripts and styles are stripped."""
    html = "<p>Hello</p><script>alert('x')</script><style>.a{}</style>"
    md = convert_to_markdown(html)
    assert "Hello" in md
    assert "alert" not in md
    assert ".a{}" not in md


# --- Phase 2: clean_markdown tests ---


def test_clean_collapses_excessive_whitespace() -> None:
    """REQ-005: Collapse 3+ blank lines to 2."""
    md = "Line 1\n\n\n\n\nLine 2"
    result = clean_markdown(md)
    assert "\n\n\n" not in result
    assert "Line 1" in result
    assert "Line 2" in result


def test_clean_removes_empty_headings() -> None:
    """REQ-005: Remove empty headings."""
    md = "# \n\n## Real Heading\n\n###  \n\nContent"
    result = clean_markdown(md)
    assert "## Real Heading" in result
    assert "Content" in result
    lines = result.split("\n")
    for line in lines:
        if re.match(r"^#{1,6}\s*$", line):
            pytest.fail(f"Found empty heading: {line!r}")


def test_clean_strips_leftover_html_tags() -> None:
    """REQ-005: Strip remaining HTML tags."""
    md = "Some <span>text</span> with <div>tags</div>"
    result = clean_markdown(md)
    assert "<span>" not in result
    assert "</span>" not in result
    assert "<div>" not in result
    assert "Some" in result
    assert "text" in result


# --- Phase 3: sanitize_filename tests ---


def test_sanitize_replaces_special_chars() -> None:
    """EDGE-005: Special characters replaced with hyphens."""
    result = sanitize_filename('My/Page:Title*"test"', "https://example.com")
    assert "/" not in result.replace(".md", "")
    assert ":" not in result.replace(".md", "")
    assert "*" not in result.replace(".md", "")
    assert '"' not in result
    assert result.endswith(".md")


def test_sanitize_collapses_consecutive_hyphens() -> None:
    """EDGE-005: Consecutive hyphens collapsed."""
    result = sanitize_filename("a///b", "https://example.com")
    assert "---" not in result
    assert result == "a-b.md"


def test_sanitize_strips_leading_trailing_hyphens() -> None:
    """EDGE-005: Leading/trailing hyphens stripped."""
    result = sanitize_filename("/title/", "https://example.com")
    assert not result.startswith("-")
    assert result == "title.md"


def test_sanitize_lowercases() -> None:
    """EDGE-005: Result is lowercased."""
    result = sanitize_filename("My Title", "https://example.com")
    assert result == result.lower()


def test_sanitize_truncates_to_100_chars() -> None:
    """EDGE-006: Title truncated to 100 chars."""
    long_title = "a" * 200
    result = sanitize_filename(long_title, "https://example.com")
    assert len(result) <= 100 + len(".md")
    assert result == "a" * 100 + ".md"


def test_sanitize_empty_title_uses_hostname() -> None:
    """EDGE-004: Empty title falls back to hostname."""
    result = sanitize_filename("", "https://example.com/page")
    assert result == "example.com.md"


def test_sanitize_whitespace_title_uses_hostname() -> None:
    """EDGE-004: Whitespace-only title falls back to hostname."""
    result = sanitize_filename("   ", "https://example.com")
    assert result == "example.com.md"


def test_sanitize_appends_md_extension() -> None:
    """REQ-006: Filename ends with .md."""
    result = sanitize_filename("my page", "https://example.com")
    assert result.endswith(".md")


# --- Phase 3: save_markdown tests ---


def test_save_markdown_creates_file(tmp_path: Path) -> None:
    """REQ-006: Save to .md file."""
    path = save_markdown("# Hello", "test.md", tmp_path)
    assert path.exists()
    assert path.read_text(encoding="utf-8") == "# Hello"
    assert path == tmp_path / "test.md"


def test_save_markdown_dedup_suffix(tmp_path: Path) -> None:
    """EDGE-007: Duplicate filenames get numeric suffix."""
    (tmp_path / "test.md").write_text("existing")
    path = save_markdown("# New", "test.md", tmp_path)
    assert path == tmp_path / "test-1.md"
    assert path.read_text(encoding="utf-8") == "# New"


def test_save_markdown_dedup_increments(tmp_path: Path) -> None:
    """EDGE-007: Numeric suffix increments."""
    (tmp_path / "test.md").write_text("existing")
    (tmp_path / "test-1.md").write_text("existing")
    path = save_markdown("# New", "test.md", tmp_path)
    assert path == tmp_path / "test-2.md"


def test_save_markdown_utf8(tmp_path: Path) -> None:
    """REQ-006: File saved with UTF-8 encoding."""
    path = save_markdown("café résumé", "test.md", tmp_path)
    assert path.read_text(encoding="utf-8") == "café résumé"


# --- Phase 3: CLI (main) tests ---


def test_cli_no_args_shows_usage() -> None:
    """EDGE-008: No args shows usage message, exit 1."""
    result = subprocess.run(
        ["python", "url2md.py"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1
    assert "Usage:" in result.stderr or "usage:" in result.stderr.lower()


def test_cli_invalid_url_exits_1() -> None:
    """EDGE-009: Invalid URL shows error, exit 1."""
    result = subprocess.run(
        ["python", "url2md.py", "not-a-url"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1
    assert "Error:" in result.stderr


@responses.activate
def test_cli_prints_output_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """REQ-007: Print output file path to stdout."""
    html = (
        "<html><head><title>Test Page</title></head>"
        "<body><p>Content here for testing.</p></body></html>"
    )
    responses.add(
        responses.GET,
        "https://example.com",
        body=html,
        content_type="text/html",
    )
    monkeypatch.setattr("sys.argv", ["url2md", "https://example.com"])
    monkeypatch.chdir(tmp_path)

    captured_stdout = StringIO()
    monkeypatch.setattr("sys.stdout", captured_stdout)

    main()

    output = captured_stdout.getvalue().strip()
    assert output.endswith(".md")
    assert Path(output).exists()


@responses.activate
def test_cli_success_exit_0(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """CLI exits 0 on success."""
    html = (
        "<html><head><title>OK</title></head>"
        "<body><p>Body content.</p></body></html>"
    )
    responses.add(
        responses.GET,
        "https://example.com",
        body=html,
        content_type="text/html",
    )
    monkeypatch.setattr("sys.argv", ["url2md", "https://example.com"])
    monkeypatch.chdir(tmp_path)

    main()


@responses.activate
def test_cli_http_failure_exits_1(capsys: pytest.CaptureFixture[str]) -> None:
    """EDGE-003: CLI exits 1 on HTTP failure."""
    responses.add(
        responses.GET,
        "https://example.com/fail",
        status=500,
    )
    import sys as _sys

    original_argv = _sys.argv
    _sys.argv = ["url2md", "https://example.com/fail"]
    try:
        with pytest.raises(SystemExit) as exc_info:
            main()
        assert exc_info.value.code == 1
    finally:
        _sys.argv = original_argv
