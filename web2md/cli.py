from __future__ import annotations

import argparse
import sys
from pathlib import Path

from web2md.converter import convert
from web2md.extractor import extract
from web2md.fetcher import fetch


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="web2md",
        description="Convert a web page to Markdown",
    )
    parser.add_argument("url", help="URL of the page to convert")
    parser.add_argument(
        "-o", "--output", type=Path, default=None, help="Write output to file"
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        soup = fetch(args.url)
    except (ConnectionError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    content = extract(soup)
    markdown = convert(content, args.url)

    if args.output is not None:
        args.output.write_text(markdown)
    else:
        sys.stdout.write(markdown)

    return 0
