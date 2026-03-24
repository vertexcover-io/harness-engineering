from __future__ import annotations

import os
import tempfile
from typing import Any
from unittest.mock import patch

import pytest

from web2md.cli import main
from web2md.fetcher import FetchError


SAMPLE_HTML = "<html><body><h1>Title</h1><p>Hello world</p></body></html>"


class TestCliStdout:
    @patch("web2md.cli.fetch_url")
    def test_url_argument_produces_markdown_on_stdout(
        self, mock_fetch: Any, capsys: pytest.CaptureFixture[str]
    ) -> None:
        mock_fetch.return_value = SAMPLE_HTML
        with pytest.raises(SystemExit) as exc:
            main(["https://example.com"])
        if exc.value.code is not None and exc.value.code != 0:
            pytest.fail(f"Expected exit 0, got {exc.value.code}")
        captured = capsys.readouterr()
        assert "# Title" in captured.out
        assert "Hello world" in captured.out


class TestCliFileOutput:
    @patch("web2md.cli.fetch_url")
    def test_output_flag_writes_to_file(
        self, mock_fetch: Any, tmp_path: Any
    ) -> None:
        mock_fetch.return_value = SAMPLE_HTML
        outfile = str(tmp_path / "out.md")
        with pytest.raises(SystemExit) as exc:
            main(["https://example.com", "-o", outfile])
        if exc.value.code is not None and exc.value.code != 0:
            pytest.fail(f"Expected exit 0, got {exc.value.code}")
        content = open(outfile).read()
        assert "# Title" in content
        assert "Hello world" in content


class TestCliErrors:
    @patch("web2md.cli.fetch_url")
    def test_non_html_url_prints_error_exits_1(
        self, mock_fetch: Any, capsys: pytest.CaptureFixture[str]
    ) -> None:
        mock_fetch.side_effect = ValueError("non-HTML content type")
        with pytest.raises(SystemExit) as exc:
            main(["https://example.com/doc.pdf"])
        assert exc.value.code == 1
        assert "error" in capsys.readouterr().err.lower()

    @patch("web2md.cli.fetch_url")
    def test_invalid_url_prints_error_exits_1(
        self, mock_fetch: Any, capsys: pytest.CaptureFixture[str]
    ) -> None:
        mock_fetch.side_effect = FetchError("Name or service not known")
        with pytest.raises(SystemExit) as exc:
            main(["https://nonexistent.invalid"])
        assert exc.value.code == 1
        assert "error" in capsys.readouterr().err.lower()
