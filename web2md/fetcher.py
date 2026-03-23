import socket
import urllib.error
import urllib.request
from urllib.parse import urlparse

from bs4 import BeautifulSoup

USER_AGENT = (
    "Mozilla/5.0 (compatible; web2md/0.1; +https://github.com/web2md)"
)
TIMEOUT = 30


def _validate_url(url: str) -> None:
    if not url:
        raise ValueError("URL must not be empty")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(
            f"Only http and https schemes are supported, got: {parsed.scheme!r}"
        )


def _extract_charset(content_type: str | None) -> str:
    if not content_type:
        return "utf-8"
    for part in content_type.split(";"):
        part = part.strip()
        if part.lower().startswith("charset="):
            return part.split("=", 1)[1].strip()
    return "utf-8"


def _validate_content_type(content_type: str | None) -> None:
    if not content_type:
        return
    mime = content_type.split(";")[0].strip().lower()
    if "html" not in mime:
        raise ValueError(f"Response is not HTML (Content-Type: {content_type})")


def fetch(url: str) -> BeautifulSoup:
    _validate_url(url)

    request = urllib.request.Request(url)
    request.add_header("User-Agent", USER_AGENT)

    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            content_type: str | None = response.getheader("Content-Type")
            _validate_content_type(content_type)
            charset = _extract_charset(content_type)
            raw = response.read()
    except urllib.error.HTTPError as e:
        raise ConnectionError(f"HTTP error {e.code}: {e.reason}") from e
    except urllib.error.URLError as e:
        reason = e.reason
        if isinstance(reason, socket.timeout):
            msg = "Request timeout: server did not respond"
            raise ConnectionError(msg) from e
        if isinstance(reason, socket.gaierror):
            host = urlparse(url).hostname
            msg = f"DNS resolution failed: could not resolve {host}"
            raise ConnectionError(msg) from e
        raise ConnectionError(f"Network error: {reason}") from e

    html = raw.decode(charset, errors="replace")
    return BeautifulSoup(html, "lxml")
