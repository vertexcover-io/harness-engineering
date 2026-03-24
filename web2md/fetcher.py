from __future__ import annotations

import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class FetchError(Exception):
    pass


def fetch_url(url: str) -> str:
    raw_bytes, content_type = _download(url)
    _validate_html(content_type)
    encoding = _detect_encoding(content_type, raw_bytes[:1024])
    return raw_bytes.decode(encoding)


def _download(url: str) -> tuple[bytes, str]:
    try:
        req = Request(url, headers={"User-Agent": "web2md/1.0"})
        with urlopen(req, timeout=10) as resp:
            content_type: str = resp.getheader("Content-Type", "") or ""
            return resp.read(), content_type
    except HTTPError as e:
        raise FetchError(f"HTTP {e.code}: {e.reason}") from e
    except URLError as e:
        raise FetchError(str(e.reason)) from e


def _validate_html(content_type: str) -> None:
    ct = content_type.split(";")[0].strip().lower()
    if ct and not ct.startswith("text/html"):
        raise ValueError(f"non-HTML content type: {ct}")


def _detect_encoding(content_type: str, head: bytes) -> str:
    charset = _charset_from_header(content_type)
    if charset:
        return charset
    charset = _charset_from_meta(head)
    if charset:
        return charset
    return "utf-8"


def _charset_from_header(content_type: str) -> str | None:
    match = re.search(r"charset=([^\s;]+)", content_type, re.IGNORECASE)
    if match:
        return match.group(1).strip()
    return None


def _charset_from_meta(head: bytes) -> str | None:
    try:
        text = head.decode("ascii", errors="ignore")
    except Exception:
        return None
    match = re.search(r'<meta\s+charset=["\']?([^"\'\s>]+)', text, re.IGNORECASE)
    if match:
        return match.group(1)
    match = re.search(
        r'<meta[^>]+content=["\'][^"\']*charset=([^"\'\s;]+)',
        text,
        re.IGNORECASE,
    )
    if match:
        return match.group(1)
    return None
