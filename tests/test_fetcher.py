from __future__ import annotations

import io
from http.client import HTTPResponse
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from web2md.fetcher import FetchError, fetch_url


def _mock_response(
    body: bytes,
    content_type: str = "text/html; charset=utf-8",
    status: int = 200,
) -> MagicMock:
    resp = MagicMock()
    resp.read.return_value = body
    resp.status = status
    resp.getheader.side_effect = lambda name, default=None: (
        content_type if name.lower() == "content-type" else default
    )
    resp.__enter__ = MagicMock(return_value=resp)
    resp.__exit__ = MagicMock(return_value=False)
    return resp


class TestFetchUrlSuccess:
    @patch("web2md.fetcher.urlopen")
    def test_returns_decoded_html(self, mock_urlopen: Any) -> None:
        html = "<html><body>Hello</body></html>"
        mock_urlopen.return_value = _mock_response(html.encode("utf-8"))
        result = fetch_url("https://example.com")
        assert result == html

    @patch("web2md.fetcher.urlopen")
    def test_uses_charset_from_content_type(self, mock_urlopen: Any) -> None:
        html = "<html><body>Héllo</body></html>"
        mock_urlopen.return_value = _mock_response(
            html.encode("iso-8859-1"),
            content_type="text/html; charset=iso-8859-1",
        )
        result = fetch_url("https://example.com")
        assert result == html

    @patch("web2md.fetcher.urlopen")
    def test_missing_charset_falls_back_to_utf8(self, mock_urlopen: Any) -> None:
        html = "<html><body>Hello</body></html>"
        mock_urlopen.return_value = _mock_response(
            html.encode("utf-8"),
            content_type="text/html",
        )
        result = fetch_url("https://example.com")
        assert result == html

    @patch("web2md.fetcher.urlopen")
    def test_meta_charset_used_when_header_missing(self, mock_urlopen: Any) -> None:
        html = '<html><head><meta charset="iso-8859-1"></head><body>Héllo</body></html>'
        mock_urlopen.return_value = _mock_response(
            html.encode("iso-8859-1"),
            content_type="text/html",
        )
        result = fetch_url("https://example.com")
        assert "Héllo" in result


class TestFetchUrlErrors:
    @patch("web2md.fetcher.urlopen")
    def test_non_html_content_type_raises_value_error(self, mock_urlopen: Any) -> None:
        mock_urlopen.return_value = _mock_response(
            b"%PDF-1.4", content_type="application/pdf"
        )
        with pytest.raises(ValueError, match="non-HTML"):
            fetch_url("https://example.com/doc.pdf")

    @patch("web2md.fetcher.urlopen")
    def test_network_error_raises_fetch_error(self, mock_urlopen: Any) -> None:
        from urllib.error import URLError
        mock_urlopen.side_effect = URLError("Name or service not known")
        with pytest.raises(FetchError):
            fetch_url("https://nonexistent.example.com")

    @patch("web2md.fetcher.urlopen")
    def test_http_404_raises_fetch_error(self, mock_urlopen: Any) -> None:
        from urllib.error import HTTPError
        mock_urlopen.side_effect = HTTPError(
            "https://example.com/404", 404, "Not Found", {}, io.BytesIO(b"")
        )
        with pytest.raises(FetchError):
            fetch_url("https://example.com/404")

    @patch("web2md.fetcher.urlopen")
    def test_http_500_raises_fetch_error(self, mock_urlopen: Any) -> None:
        from urllib.error import HTTPError
        mock_urlopen.side_effect = HTTPError(
            "https://example.com/500", 500, "Server Error", {}, io.BytesIO(b"")
        )
        with pytest.raises(FetchError):
            fetch_url("https://example.com/500")
