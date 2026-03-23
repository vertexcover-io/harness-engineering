# Preferences
- If the project is using TDD always prefer TDD Approach
- Ask before committing to git
- Prefer editing existing files over creating new ones. 
- Try keeping flat folder structure and lesser no of files
- Keep code simple — no over-engineering
- No unnecessary comments or docstrings
- Capture Learnings using learn skill wherever possible
- Use typescript:strict mode, and use type hints for all functions in python
- Use code-quality skill for writing high quality code and try to make it functional

## Workflow
- Explore codebase before implementing changes
- Plan before coding on complex tasks
- When something goes sideways, stop and re-plan — don't keep pushing
- After finishing a task: run typecheck, tests, and lint before calling it done

## Style
- Prefer small, focused functions
- Use early returns over nested conditionals

## Communication
Ask clarifying questions before architectural changes
Explain reasoning for non-obvious decisions

## Project: web2md

A Python CLI tool that fetches a web page and converts its main content to clean Markdown.

### Architecture
- `web2md/fetcher.py` -- `fetch(url) -> BeautifulSoup` via urllib with User-Agent, 30s timeout, encoding detection
- `web2md/extractor.py` -- `extract(soup) -> Tag` scoring-based content extraction (strips nav/sidebar/footer)
- `web2md/converter.py` -- `convert(soup, base_url) -> str` recursive tree walker with tag-handler map
- `web2md/cli.py` -- `main(argv) -> int` argparse entry point wiring fetch -> extract -> convert -> output
- `web2md/__main__.py` -- `python -m web2md` support

### Commands
- **Run:** `python -m web2md <url>` or `python -m web2md <url> -o output.md`
- **Tests:** `pytest tests/`
- **Type check:** `mypy web2md/`
- **Lint:** `ruff check web2md/`
- **Install dev:** `pip install -e ".[dev]"`

### Dependencies
- Runtime: beautifulsoup4, lxml
- Dev: pytest, mypy, ruff, lxml-stubs

### Test Coverage
111 tests, 94% coverage. Tests use mocked urllib (no network access needed).

## Prior Learnings
- Before implementing, check `docs/solutions/` for relevant gotchas and patterns
- Search by tags/keywords related to the feature area: `Grep pattern="<keyword>" path=docs/solutions/`
- Critical gotchas that caused pipeline failures:
  <!-- Updated automatically by learn skill -->
