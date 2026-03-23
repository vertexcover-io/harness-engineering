from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import urlparse

import requests
from lxml import etree
from markdownify import markdownify as md
from readability import Document  # type: ignore[import-untyped]

USER_AGENT = "url2md/0.1.0"
TIMEOUT_SECONDS = 30
MAX_REDIRECTS = 5
HTML_CONTENT_TYPES = {"text/html", "application/xhtml+xml"}


def _error_exit(message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(1)


def _validate_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        _error_exit("Error: Invalid URL")


def _check_content_type(content_type: str) -> None:
    media_type = content_type.split(";")[0].strip().lower()
    if media_type not in HTML_CONTENT_TYPES:
        _error_exit(f"Error: URL returned non-HTML content type: {media_type}")


def fetch_html(url: str) -> tuple[str, str]:
    _validate_url(url)

    session = requests.Session()
    session.max_redirects = MAX_REDIRECTS
    session.headers["User-Agent"] = USER_AGENT

    try:
        response = session.get(url, timeout=TIMEOUT_SECONDS, allow_redirects=True)
    except requests.exceptions.Timeout:
        _error_exit("Error: Request timed out")
    except requests.exceptions.ConnectionError as e:
        _error_exit(f"Error: {e}")
    except requests.exceptions.RequestException as e:
        _error_exit(f"Error: {e}")

    if response.status_code >= 400:
        _error_exit(f"Error: HTTP {response.status_code}")

    content_type = response.headers.get("Content-Type", "")
    _check_content_type(content_type)

    if response.encoding and response.encoding.lower() != "utf-8":
        response.encoding = response.apparent_encoding or response.encoding

    return response.text, response.url


def _has_meaningful_content(html: str) -> bool:
    text = re.sub(r"<[^>]+>", "", html).strip()
    return len(text) > 0


def _get_body_content(html: str) -> str:
    tree = etree.HTML(html)
    if tree is None:
        raise ValueError("No content found")
    body = tree.find(".//body")
    if body is None:
        raise ValueError("No content found")
    result: str = etree.tostring(body, encoding="unicode", method="html")
    return result


_BOILERPLATE_TAGS = {"nav", "footer", "aside", "header"}


def _strip_boilerplate(html: str) -> str:
    tree = etree.HTML(html)
    if tree is None:
        return html
    for tag in _BOILERPLATE_TAGS:
        for el in tree.findall(f".//{tag}"):
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)
    body = tree.find(".//body")
    if body is None:
        return html
    result: str = etree.tostring(body, encoding="unicode", method="html")
    return result


def extract_content(html: str) -> tuple[str, str]:
    tree = etree.HTML(html)
    if tree is None or tree.find(".//body") is None:
        raise ValueError("No content found")

    doc = Document(html)
    raw_title = doc.title() or ""
    title = "" if raw_title == "[no-title]" else raw_title
    content = doc.summary()

    if not _has_meaningful_content(content):
        content = _get_body_content(html)

    content = _strip_boilerplate(content)
    return content, title


def _remove_tags_with_content(html: str, tags: list[str]) -> str:
    for tag in tags:
        html = re.sub(
            rf"<{tag}[^>]*>.*?</{tag}>", "", html, flags=re.DOTALL | re.IGNORECASE
        )
    return html


def convert_to_markdown(html: str) -> str:
    cleaned = _remove_tags_with_content(html, ["script", "style"])
    result: str = md(cleaned, heading_style="ATX")
    return result


def clean_markdown(text: str) -> str:
    result = re.sub(r"\n{3,}", "\n\n", text)
    result = re.sub(r"^#{1,6}\s*$", "", result, flags=re.MULTILINE)
    result = re.sub(r"<[^>]+>", "", result)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


_SPECIAL_CHARS = re.compile(r'[/\\:*?"<>|]')


def sanitize_filename(title: str, url: str) -> str:
    name = title.strip()
    if not name:
        name = urlparse(url).hostname or "untitled"
    name = _SPECIAL_CHARS.sub("-", name)
    name = re.sub(r"-{2,}", "-", name)
    name = name.strip("-").strip()
    name = name[:100]
    return name.lower() + ".md"


def save_markdown(markdown: str, filename: str, output_dir: Path) -> Path:
    path = output_dir / filename
    if not path.exists():
        path.write_text(markdown, encoding="utf-8")
        return path

    stem = filename.removesuffix(".md")
    counter = 1
    while True:
        candidate = output_dir / f"{stem}-{counter}.md"
        if not candidate.exists():
            candidate.write_text(markdown, encoding="utf-8")
            return candidate
        counter += 1


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: url2md <url>", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]
    html, final_url = fetch_html(url)
    content, title = extract_content(html)
    markdown = convert_to_markdown(content)
    cleaned = clean_markdown(markdown)
    filename = sanitize_filename(title, final_url)
    output_dir = Path.cwd()
    path = save_markdown(cleaned, filename, output_dir)
    print(path)


if __name__ == "__main__":
    main()
