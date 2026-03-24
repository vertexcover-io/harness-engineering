# web2md

A Python CLI tool that fetches web pages and converts them to clean Markdown. Built entirely with Python stdlib -- zero third-party dependencies.

## Architecture

```
URL --> [Fetcher] --> raw HTML
                        |
                [TreeBuilder] --> DOM tree
                                    |
                          [Renderer] --> Markdown string
                                            |
                                  [CLI] --> stdout / file
```

- **Fetcher** (`web2md/fetcher.py`): Downloads pages via `urllib.request`, detects encoding from Content-Type header, `<meta charset>`, or falls back to UTF-8.
- **Tree Builder** (`web2md/tree_builder.py`): Subclasses `html.parser.HTMLParser` to build a lightweight DOM tree. Handles void elements, implicit tag closes, entity decoding, and strips `<script>`, `<style>`, `<nav>`, `<footer>`, `<header>` content.
- **Node Model** (`web2md/nodes.py`): Simple dataclass tree -- each node has a tag, attributes dict, and children list.
- **Renderer** (`web2md/renderer.py`): Recursive tree walker that dispatches on node tag. Passes context (list depth, pre mode, blockquote depth) through recursion. Handles headings, paragraphs, links, images, lists (nested), bold, italic, strikethrough, code (inline and fenced), blockquotes, tables, and horizontal rules.
- **CLI** (`web2md/cli.py`): `argparse`-based entry point.

## Usage

```bash
# Print Markdown to stdout
python -m web2md https://example.com

# Write to file
python -m web2md https://example.com -o output.md
```

If installed via pip/pyproject.toml:

```bash
web2md https://example.com
web2md https://example.com -o output.md
```

## Supported Elements

| HTML | Markdown |
|------|----------|
| `<h1>`-`<h6>` | `#` - `######` |
| `<p>` | Text blocks separated by blank lines |
| `<a href="url">text</a>` | `[text](url)` |
| `<img src="url" alt="desc">` | `![desc](url)` |
| `<ul>/<li>` | `- item` |
| `<ol>/<li>` | `1. item` |
| Nested lists | Indented by 2 spaces per level |
| `<b>`, `<strong>` | `**bold**` |
| `<i>`, `<em>` | `*italic*` |
| `<s>`, `<del>` | `~~strikethrough~~` |
| `<code>` | `` `inline code` `` |
| `<pre><code>` | Fenced code blocks |
| `<blockquote>` | `> quote` |
| `<table>` | Pipe-delimited tables |
| `<hr>` | `---` |
| `<br>` | Newline |

## Requirements

- Python >= 3.10
- No third-party dependencies (pytest is dev-only)

## Development

```bash
# Run tests
pytest tests/

# Type check
mypy web2md/
```
