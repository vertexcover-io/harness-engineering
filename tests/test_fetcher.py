import http.client
import socket
import urllib.error
import urllib.request
from io import BytesIO
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from bs4 import BeautifulSoup

from web2md.fetcher import fetch


class FakeResponse:
    def __init__(
        self,
        data: bytes,
        headers: dict[str, str] | None = None,
        url: str = "https://example.com",
        status: int = 200,
    ) -> None:
        self._data = data
        self._headers = headers or {"Content-Type": "text/html; charset=utf-8"}
        self.url = url
        self.status = status

    def read(self) -> bytes:
        return self._data

    def getheader(self, name: str, default: str | None = None) -> str | None:
        return self._headers.get(name, default)

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: Any) -> None:
        pass


# REQ-003, REQ-004: Successful fetch returns BeautifulSoup with lxml parser
class TestFetchSuccess:
    @patch("web2md.fetcher.urllib.request.urlopen")
    def test_returns_beautifulsoup_object(self, mock_urlopen: MagicMock) -> None:
        html = b"<html><body><p>hello</p></body></html>"
        mock_urlopen.return_value = FakeResponse(html)

        result = fetch("https://example.com")

        assert isinstance(result, BeautifulSoup)

    @patch("web2md.fetcher.urllib.request.urlopen")
    def test_parsed_content_is_correct(self, mock_urlopen: MagicMock) -> None:
        html = b"<html><body><p>hello</p></body></html>"
        mock_urlopen.return_value = FakeResponse(html)

        result = fetch("https://example.com")

        assert result.find("p") is not None
        assert result.find("p").get_text() == "hello"  # type: ignore[union-attr]


# REQ-003: User-Agent header and 30s timeout
class TestRequestHeaders:
    @patch("web2md.fetcher.urllib.request.urlopen")
    def test_user_agent_is_set(self, mock_urlopen: MagicMock) -> None:
        html = b"<html><body></body></html>"
        mock_urlopen.return_value = FakeResponse(html)

        fetch("https://example.com")

        call_args = mock_urlopen.call_args
        request = call_args[0][0]
        assert isinstance(request, urllib.request.Request)
        ua = request.get_header("User-agent")
        assert ua is not None
        assert len(ua) > 0

    @patch("web2md.fetcher.urllib.request.urlopen")
    def test_timeout_is_30_seconds(self, mock_urlopen: MagicMock) -> None:
        html = b"<html><body></body></html>"
        mock_urlopen.return_value = FakeResponse(html)

        fetch("https://example.com")

        call_args = mock_urlopen.call_args
        assert call_args[1].get("timeout") == 30 or (
            len(call_args[0]) > 1 and call_args[0][1] == 30
        )


# REQ-021: Non-HTML content type raises ValueError
class TestContentTypeValidation:
    @patch("web2md.fetcher.urllib.request.urlopen")
    def test_pdf_content_type_raises(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = FakeResponse(
            b"%PDF", headers={"Content-Type": "application/pdf"}
        )

        with pytest.raises(ValueError, match="(?i)(not html|application/pdf)"):
            fetch("https://example.com/file.pdf")

    @patch("web2md.fetcher.urllib.request.urlopen")
    def test_image_content_type_raises(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = FakeResponse(
            b"\x89PNG", headers={"Content-Type": "image/png"}
        )

        with pytest.raises(ValueError, match="(?i)(not html|image/png)"):
            fetch("https://example.com/img.png")


# EDGE-008: HTTP 403/404 raises error with status code
class TestHttpErrors:
    @patch("web2md.fetcher.urllib.request.urlopen")
    def test_http_403_raises_with_status(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.side_effect = urllib.error.HTTPError(
            "https://example.com", 403, "Forbidden", {}, BytesIO(b"")  # type: ignore[arg-type]
        )

        with pytest.raises(Exception, match="403"):
            fetch("https://example.com")

    @patch("web2md.fetcher.urllib.request.urlopen")
    def test_http_404_raises_with_status(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.side_effect = urllib.error.HTTPError(
            "https://example.com", 404, "Not Found", {}, BytesIO(b"")  # type: ignore[arg-type]
        )

        with pytest.raises(Exception, match="404"):
            fetch("https://example.com")


# REQ-022: Timeout raises error with "timeout" in message
class TestNetworkErrors:
    @patch("web2md.fetcher.urllib.request.urlopen")
    def test_timeout_raises_with_message(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.side_effect = urllib.error.URLError(socket.timeout("timed out"))

        with pytest.raises(Exception, match="(?i)timeout"):
            fetch("https://example.com")

    @patch("web2md.fetcher.urllib.request.urlopen")
    def test_dns_failure_raises_with_hostname(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.side_effect = urllib.error.URLError(
            socket.gaierror(8, "Name or service not known: badhost.invalid")
        )

        with pytest.raises(Exception, match="(?i)(resolve|badhost)"):
            fetch("https://badhost.invalid")


# REQ-024: Charset detection
class TestCharsetDetection:
    @patch("web2md.fetcher.urllib.request.urlopen")
    def test_charset_from_content_type_header(self, mock_urlopen: MagicMock) -> None:
        html = "<html><body><p>caf\u00e9</p></body></html>".encode("latin-1")
        mock_urlopen.return_value = FakeResponse(
            html, headers={"Content-Type": "text/html; charset=latin-1"}
        )

        result = fetch("https://example.com")

        assert "caf\u00e9" in result.get_text()

    @patch("web2md.fetcher.urllib.request.urlopen")
    def test_charset_fallback_to_utf8(self, mock_urlopen: MagicMock) -> None:
        html = "<html><body><p>hello</p></body></html>".encode("utf-8")
        mock_urlopen.return_value = FakeResponse(
            html, headers={"Content-Type": "text/html"}
        )

        result = fetch("https://example.com")

        assert "hello" in result.get_text()


# URL scheme validation
class TestUrlValidation:
    def test_ftp_scheme_raises(self) -> None:
        with pytest.raises(ValueError, match="(?i)(http|scheme)"):
            fetch("ftp://example.com/file")

    def test_empty_url_raises(self) -> None:
        with pytest.raises(ValueError):
            fetch("")

    def test_no_scheme_raises(self) -> None:
        with pytest.raises(ValueError):
            fetch("example.com")
