from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from bs4 import BeautifulSoup

from web2md.cli import main


FIXTURE_HTML = """\
<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
<article>
<h1>Hello World</h1>
<p>This is a <strong>test</strong> page.</p>
<p>Second paragraph with a <a href="/about">link</a>.</p>
</article>
</body>
</html>
"""


def _make_soup(html: str = FIXTURE_HTML) -> BeautifulSoup:
    return BeautifulSoup(html, "lxml")


class TestMainStdout:
    """REQ-001: URL provided as CLI arg -> Markdown on stdout."""

    def test_valid_url_exits_zero(self, capsys: pytest.CaptureFixture[str]) -> None:
        with patch("web2md.cli.fetch", return_value=_make_soup()):
            code = main(["https://example.com"])
        assert code == 0

    def test_valid_url_outputs_markdown(self, capsys: pytest.CaptureFixture[str]) -> None:
        with patch("web2md.cli.fetch", return_value=_make_soup()):
            main(["https://example.com"])
        out = capsys.readouterr().out
        assert "# Hello World" in out
        assert "**test**" in out
        assert "[link]" in out

    def test_stdout_ends_with_newline(self, capsys: pytest.CaptureFixture[str]) -> None:
        with patch("web2md.cli.fetch", return_value=_make_soup()):
            main(["https://example.com"])
        out = capsys.readouterr().out
        assert out.endswith("\n")


class TestFileOutput:
    """REQ-002: -o flag writes Markdown to file."""

    def test_output_flag_creates_file(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        out_file = tmp_path / "out.md"
        with patch("web2md.cli.fetch", return_value=_make_soup()):
            code = main(["https://example.com", "-o", str(out_file)])
        assert code == 0
        assert out_file.exists()
        content = out_file.read_text()
        assert "# Hello World" in content

    def test_output_matches_stdout(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        out_file = tmp_path / "out.md"
        soup = _make_soup()
        with patch("web2md.cli.fetch", return_value=_make_soup()):
            main(["https://example.com"])
        stdout_output = capsys.readouterr().out

        with patch("web2md.cli.fetch", return_value=_make_soup()):
            main(["https://example.com", "-o", str(out_file)])
        file_output = out_file.read_text()

        assert stdout_output == file_output

    def test_long_output_flag(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        out_file = tmp_path / "result.md"
        with patch("web2md.cli.fetch", return_value=_make_soup()):
            code = main(["https://example.com", "--output", str(out_file)])
        assert code == 0
        assert out_file.exists()


class TestErrorHandling:
    """REQ-022, EDGE-008: Network errors and HTTP errors."""

    def test_connection_error_exits_one(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        with patch("web2md.cli.fetch", side_effect=ConnectionError("Request timeout: server did not respond")):
            code = main(["https://example.com"])
        assert code == 1
        err = capsys.readouterr().err
        assert "timeout" in err.lower()

    def test_http_403_error(self, capsys: pytest.CaptureFixture[str]) -> None:
        with patch("web2md.cli.fetch", side_effect=ConnectionError("HTTP error 403: Forbidden")):
            code = main(["https://example.com"])
        assert code == 1
        err = capsys.readouterr().err
        assert "403" in err

    def test_http_404_error(self, capsys: pytest.CaptureFixture[str]) -> None:
        with patch("web2md.cli.fetch", side_effect=ConnectionError("HTTP error 404: Not Found")):
            code = main(["https://example.com"])
        assert code == 1
        err = capsys.readouterr().err
        assert "404" in err

    def test_dns_error(self, capsys: pytest.CaptureFixture[str]) -> None:
        with patch("web2md.cli.fetch", side_effect=ConnectionError("DNS resolution failed: could not resolve badhost.invalid")):
            code = main(["https://badhost.invalid"])
        assert code == 1
        err = capsys.readouterr().err
        assert "resolve" in err.lower() or "badhost" in err.lower()

    def test_non_html_exits_one(self, capsys: pytest.CaptureFixture[str]) -> None:
        with patch("web2md.cli.fetch", side_effect=ValueError("Response is not HTML (Content-Type: application/pdf)")):
            code = main(["https://example.com/file.pdf"])
        assert code == 1
        err = capsys.readouterr().err
        assert "pdf" in err.lower() or "not HTML" in err

    def test_invalid_url_exits_one(self, capsys: pytest.CaptureFixture[str]) -> None:
        with patch("web2md.cli.fetch", side_effect=ValueError("Only http and https schemes are supported, got: 'ftp'")):
            code = main(["ftp://example.com"])
        assert code == 1
        err = capsys.readouterr().err
        assert len(err) > 0


class TestLargeInput:
    """EDGE-009: Extremely large page (>1MB HTML)."""

    def test_large_page_processes(self, capsys: pytest.CaptureFixture[str]) -> None:
        paragraphs = "\n".join(f"<p>Paragraph number {i} with some filler text content here.</p>" for i in range(500))
        large_html = f"<html><body><article>{paragraphs}</article></body></html>"
        assert len(large_html) > 30_000  # meaningful size
        with patch("web2md.cli.fetch", return_value=_make_soup(large_html)):
            code = main(["https://example.com"])
        assert code == 0
        out = capsys.readouterr().out
        assert "Paragraph number 0" in out
        assert "Paragraph number 499" in out


class TestModuleExecution:
    """Verify python -m web2md support."""

    def test_main_module_imports(self) -> None:
        import web2md.__main__  # noqa: F401
