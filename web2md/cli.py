from __future__ import annotations

import argparse
import sys

from web2md.fetcher import FetchError, fetch_url
from web2md.renderer import render
from web2md.tree_builder import parse_html


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Convert web pages to Markdown")
    parser.add_argument("url", help="URL to fetch and convert")
    parser.add_argument("-o", "--output", help="Write output to file")
    args = parser.parse_args(argv)

    try:
        html = fetch_url(args.url)
    except (FetchError, ValueError) as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    tree = parse_html(html)
    markdown = render(tree)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(markdown)
    else:
        print(markdown)

    sys.exit(0)
