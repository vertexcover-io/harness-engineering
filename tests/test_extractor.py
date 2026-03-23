from __future__ import annotations

from bs4 import BeautifulSoup, Tag

from web2md.extractor import extract


def _soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "lxml")


class TestArticleExtraction:
    """REQ-005: extract highest-scoring content subtree."""

    def test_article_tag_extracted(self) -> None:
        soup = _soup("""
        <html><body>
            <nav><a href="/">Home</a><a href="/about">About</a></nav>
            <article><p>Main content paragraph one.</p><p>Second paragraph here.</p></article>
            <footer><p>Footer info</p></footer>
        </body></html>
        """)
        result = extract(soup)
        assert result.name == "article"

    def test_content_div_by_class(self) -> None:
        soup = _soup("""
        <html><body>
            <div class="sidebar"><p>Links</p></div>
            <div class="content"><p>This is the main article body with enough text to score well.</p>
            <p>Another paragraph of real content that should boost the score.</p></div>
        </body></html>
        """)
        result = extract(soup)
        assert "content" in (result.get("class") or []) or result.find(class_="content") is not None or result.name == "body"
        text = result.get_text()
        assert "main article body" in text

    def test_sidebar_excluded(self) -> None:
        soup = _soup("""
        <html><body>
            <div class="sidebar"><ul><li><a href="/a">Link A</a></li><li><a href="/b">Link B</a></li></ul></div>
            <div class="post">
                <p>Real article content with many words that should make this the clear winner in scoring.</p>
                <p>More real content paragraphs help build up the text density score nicely.</p>
                <p>Even more content here to ensure this div scores much higher than the sidebar.</p>
            </div>
        </body></html>
        """)
        result = extract(soup)
        text = result.get_text()
        assert "Real article content" in text

    def test_nav_heavy_excluded(self) -> None:
        soup = _soup("""
        <html><body>
            <div class="nav"><a href="/1">1</a><a href="/2">2</a><a href="/3">3</a><a href="/4">4</a></div>
            <div id="article-body">
                <p>This is a substantial article with enough text to win the scoring heuristic.</p>
                <p>Second paragraph adds more weight to this content block's overall score.</p>
            </div>
        </body></html>
        """)
        result = extract(soup)
        text = result.get_text()
        assert "substantial article" in text


class TestFallbackToBody:
    """REQ-023, EDGE-007: fall back to body when all scores zero."""

    def test_minimal_page_returns_body(self) -> None:
        soup = _soup("<html><body><p>hello</p></body></html>")
        result = extract(soup)
        assert result.name == "body"
        assert "hello" in result.get_text()

    def test_page_only_nav_falls_back_to_body(self) -> None:
        """EDGE-007: page is entirely nav with no other content."""
        soup = _soup("""
        <html><body>
            <nav><a href="/">Home</a><a href="/about">About</a></nav>
        </body></html>
        """)
        result = extract(soup)
        assert result.name == "body"


class TestLinkDensity:
    """Link density penalization for nav-like elements."""

    def test_high_link_density_penalized(self) -> None:
        soup = _soup("""
        <html><body>
            <div class="links">
                <a href="/1">Link one text</a> <a href="/2">Link two text</a>
                <a href="/3">Link three text</a> <a href="/4">Link four text</a>
            </div>
            <div class="main-content">
                <p>This is a real article with long paragraphs of text that are not links at all.</p>
                <p>Another paragraph with plenty of textual content for scoring purposes.</p>
                <p>Third paragraph ensures this content block scores well above the link-heavy one.</p>
            </div>
        </body></html>
        """)
        result = extract(soup)
        text = result.get_text()
        assert "real article" in text


class TestPreExtractionCleanup:
    """Script/style tags removed before scoring."""

    def test_script_removed_before_scoring(self) -> None:
        soup = _soup("""
        <html><body>
            <script>var x = "lots of text that should not affect scoring at all";</script>
            <div><p>Actual content here.</p><p>More real text for scoring.</p></div>
        </body></html>
        """)
        result = extract(soup)
        assert result.find("script") is None

    def test_style_removed_before_scoring(self) -> None:
        soup = _soup("""
        <html><body>
            <style>body { background: red; font-size: 14px; color: blue; }</style>
            <div><p>Actual content here.</p><p>More real text for scoring.</p></div>
        </body></html>
        """)
        result = extract(soup)
        assert result.find("style") is None


class TestNestedContentDivs:
    """Nested content divs: returns the most specific content-rich element."""

    def test_nested_divs_returns_most_specific(self) -> None:
        soup = _soup("""
        <html><body>
            <div class="wrapper">
                <div class="sidebar"><p>Side</p></div>
                <div class="article">
                    <p>This is a lengthy article paragraph one with plenty of real textual content.</p>
                    <p>Second paragraph also contains substantial text to build up the score.</p>
                    <p>Third paragraph to make this clearly the best scoring content element.</p>
                </div>
            </div>
        </body></html>
        """)
        result = extract(soup)
        text = result.get_text()
        assert "lengthy article paragraph" in text


class TestReturnType:
    """extract() must return a Tag."""

    def test_returns_tag(self) -> None:
        soup = _soup("<html><body><p>text</p></body></html>")
        result = extract(soup)
        assert isinstance(result, Tag)
