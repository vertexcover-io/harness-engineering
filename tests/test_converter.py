from bs4 import BeautifulSoup, Tag

from web2md.converter import convert, strip_unwanted_tags


def _make_soup(html: str) -> Tag:
    soup = BeautifulSoup(html, "lxml")
    body = soup.body
    assert body is not None
    return body


def _convert(html: str, base_url: str = "https://example.com") -> str:
    soup = BeautifulSoup(html, "lxml")
    return convert(soup, base_url)


class TestHeadings:
    """REQ-006: h1-h6 → # through ######"""

    def test_h1(self) -> None:
        assert "# Hello" in _convert("<h1>Hello</h1>")

    def test_h2(self) -> None:
        assert "## World" in _convert("<h2>World</h2>")

    def test_h3(self) -> None:
        assert "### Level 3" in _convert("<h3>Level 3</h3>")

    def test_h4(self) -> None:
        assert "#### Level 4" in _convert("<h4>Level 4</h4>")

    def test_h5(self) -> None:
        assert "##### Level 5" in _convert("<h5>Level 5</h5>")

    def test_h6(self) -> None:
        assert "###### Level 6" in _convert("<h6>Level 6</h6>")


class TestParagraphs:
    """REQ-007: paragraphs separated by blank lines"""

    def test_single_paragraph(self) -> None:
        result = _convert("<p>Hello world</p>")
        assert "Hello world" in result

    def test_two_paragraphs_separated_by_blank_line(self) -> None:
        result = _convert("<p>First</p><p>Second</p>")
        assert "First\n\nSecond" in result

    def test_empty_paragraph_skipped(self) -> None:
        """REQ-025: empty elements produce no output"""
        result = _convert("<p></p>")
        assert result.strip() == ""


class TestLinks:
    """REQ-008: <a href> → [text](url)"""

    def test_simple_link(self) -> None:
        result = _convert('<a href="https://x.com">click</a>')
        assert "[click](https://x.com)" in result

    def test_link_no_href(self) -> None:
        """EDGE-003: link with no href → just text"""
        result = _convert("<a>text</a>")
        assert "text" in result
        assert "[" not in result

    def test_relative_link(self) -> None:
        """REQ-018: relative URL resolved"""
        result = _convert('<a href="/about">About</a>', base_url="https://example.com/page")
        assert "[About](https://example.com/about)" in result

    def test_relative_url_with_dotdot(self) -> None:
        """EDGE-014: relative URL with ../ segments"""
        result = _convert(
            '<a href="../other">Link</a>',
            base_url="https://example.com/dir/page",
        )
        assert "[Link](https://example.com/other)" in result


class TestImages:
    """REQ-009: <img> → ![alt](src)"""

    def test_image_with_alt(self) -> None:
        result = _convert('<img src="pic.jpg" alt="photo">')
        assert "![photo](https://example.com/pic.jpg)" in result

    def test_image_no_alt(self) -> None:
        """EDGE-004: image with no alt → empty alt"""
        result = _convert('<img src="pic.jpg">')
        assert "![](https://example.com/pic.jpg)" in result

    def test_image_relative_src(self) -> None:
        result = _convert(
            '<img src="/images/cat.png" alt="cat">',
            base_url="https://example.com",
        )
        assert "![cat](https://example.com/images/cat.png)" in result


class TestInlineFormatting:
    """REQ-010: bold/italic"""

    def test_strong(self) -> None:
        assert "**bold**" in _convert("<strong>bold</strong>")

    def test_b(self) -> None:
        assert "**bold**" in _convert("<b>bold</b>")

    def test_em(self) -> None:
        assert "*italic*" in _convert("<em>italic</em>")

    def test_i(self) -> None:
        assert "*italic*" in _convert("<i>italic</i>")

    def test_nested_bold_italic(self) -> None:
        result = _convert("<strong><em>text</em></strong>")
        assert "***text***" in result

    def test_bold_across_paragraph_boundary(self) -> None:
        """EDGE-006: bold markers don't span blocks"""
        result = _convert("<p><strong>first</strong></p><p><strong>second</strong></p>")
        assert "**first**" in result
        assert "**second**" in result


class TestStrikethrough:
    """REQ-016: del/s → ~~text~~"""

    def test_del(self) -> None:
        assert "~~removed~~" in _convert("<del>removed</del>")

    def test_s(self) -> None:
        assert "~~struck~~" in _convert("<s>struck</s>")


class TestInlineCode:
    """REQ-011 (inline only): <code> → backticks"""

    def test_inline_code(self) -> None:
        assert "`x`" in _convert("<code>x</code>")

    def test_code_with_backticks(self) -> None:
        """EDGE-005: code containing backticks → double backtick delimiters"""
        result = _convert("<code>use `x`</code>")
        assert "`` use `x` ``" in result


class TestHorizontalRule:
    """REQ-015: <hr> → ---"""

    def test_hr(self) -> None:
        result = _convert("<p>above</p><hr><p>below</p>")
        assert "---" in result


class TestLineBreak:
    """br → newline"""

    def test_br(self) -> None:
        result = _convert("<p>line1<br>line2</p>")
        assert "line1\nline2" in result


class TestTagStripping:
    """REQ-019: strip script/style/nav/footer/header/aside"""

    def test_script_stripped(self) -> None:
        result = _convert("<p>keep</p><script>alert(1)</script>")
        assert "alert" not in result
        assert "keep" in result

    def test_style_stripped(self) -> None:
        result = _convert("<p>keep</p><style>.x{color:red}</style>")
        assert "color" not in result

    def test_nav_stripped(self) -> None:
        result = _convert("<nav>navigation</nav><p>content</p>")
        assert "navigation" not in result
        assert "content" in result

    def test_footer_stripped(self) -> None:
        result = _convert("<footer>foot</footer><p>content</p>")
        assert "foot" not in result

    def test_header_stripped(self) -> None:
        result = _convert("<header>head</header><p>content</p>")
        assert "head" not in result
        assert "content" in result

    def test_aside_stripped(self) -> None:
        result = _convert("<aside>sidebar</aside><p>content</p>")
        assert "sidebar" not in result


class TestURLResolution:
    """REQ-018: relative → absolute URL"""

    def test_absolute_url_unchanged(self) -> None:
        result = _convert('<a href="https://other.com/page">link</a>')
        assert "[link](https://other.com/page)" in result

    def test_base_tag_override(self) -> None:
        """EDGE-015: <base href> overrides page URL"""
        html = '<html><head><base href="https://cdn.example.com/"></head><body><a href="page">link</a></body></html>'
        result = _convert(html, base_url="https://example.com")
        assert "[link](https://cdn.example.com/page)" in result

    def test_protocol_relative_url(self) -> None:
        result = _convert(
            '<a href="//cdn.example.com/file">link</a>',
            base_url="https://example.com",
        )
        assert "[link](https://cdn.example.com/file)" in result


class TestWhitespace:
    """REQ-020: whitespace management"""

    def test_collapse_inline_whitespace(self) -> None:
        result = _convert("<p>hello    world</p>")
        assert "hello world" in result

    def test_no_triple_newlines(self) -> None:
        result = _convert("<p>a</p><p>b</p><p>c</p>")
        assert "\n\n\n" not in result

    def test_newlines_collapsed_in_inline(self) -> None:
        result = _convert("<p>hello\n\n   world</p>")
        assert "hello world" in result


class TestEmptyElements:
    """REQ-025: empty elements produce no output"""

    def test_empty_div(self) -> None:
        result = _convert("<div></div>")
        assert result.strip() == ""

    def test_empty_span(self) -> None:
        result = _convert("<p>before<span></span>after</p>")
        assert "beforeafter" in result


class TestGenericElements:
    """span/div just recurse into children"""

    def test_div_transparent(self) -> None:
        result = _convert("<div><p>hello</p></div>")
        assert "hello" in result

    def test_span_transparent(self) -> None:
        result = _convert("<p>hello <span>world</span></p>")
        assert "hello world" in result


class TestUnorderedLists:
    """REQ-012: ul/ol → Markdown lists"""

    def test_simple_unordered_list(self) -> None:
        html = "<ul><li>Alpha</li><li>Beta</li><li>Gamma</li></ul>"
        result = _convert(html)
        assert "- Alpha\n- Beta\n- Gamma" in result

    def test_nested_2_levels(self) -> None:
        html = "<ul><li>A<ul><li>B</li></ul></li></ul>"
        result = _convert(html)
        assert "- A\n  - B" in result

    def test_nested_3_levels(self) -> None:
        html = "<ul><li>A<ul><li>B<ul><li>C</li></ul></li></ul></li></ul>"
        result = _convert(html)
        assert "- A\n  - B\n    - C" in result

    def test_nested_4_levels(self) -> None:
        """EDGE-001: 4-level nested list"""
        html = "<ul><li>A<ul><li>B<ul><li>C<ul><li>D</li></ul></li></ul></li></ul></li></ul>"
        result = _convert(html)
        assert "- A\n  - B\n    - C\n      - D" in result

    def test_empty_list_item(self) -> None:
        html = "<ul><li></li><li>Item</li></ul>"
        result = _convert(html)
        assert "- Item" in result


class TestOrderedLists:
    """REQ-012: ordered lists with correct numbering"""

    def test_simple_ordered_list(self) -> None:
        html = "<ol><li>First</li><li>Second</li><li>Third</li></ol>"
        result = _convert(html)
        assert "1. First\n2. Second\n3. Third" in result

    def test_nested_ordered_list(self) -> None:
        html = "<ol><li>A<ol><li>B</li><li>C</li></ol></li></ol>"
        result = _convert(html)
        assert "1. A\n  1. B\n  2. C" in result


class TestMixedLists:
    """EDGE-010: mixed ordered and unordered nested lists"""

    def test_ul_inside_ol(self) -> None:
        html = "<ol><li>Ordered<ul><li>Unordered</li></ul></li></ol>"
        result = _convert(html)
        assert "1. Ordered\n  - Unordered" in result

    def test_ol_inside_ul(self) -> None:
        html = "<ul><li>Unordered<ol><li>Ordered</li></ol></li></ul>"
        result = _convert(html)
        assert "- Unordered\n  1. Ordered" in result


class TestBlockquotes:
    """REQ-013: blockquote → > prefix"""

    def test_simple_blockquote(self) -> None:
        html = "<blockquote>text</blockquote>"
        result = _convert(html)
        assert "> text" in result

    def test_blockquote_with_paragraph(self) -> None:
        html = "<blockquote><p>paragraph</p></blockquote>"
        result = _convert(html)
        assert "> paragraph" in result

    def test_nested_blockquotes(self) -> None:
        html = "<blockquote><blockquote>deep</blockquote></blockquote>"
        result = _convert(html)
        assert "> > deep" in result

    def test_blockquote_containing_list(self) -> None:
        """EDGE-011: list inside blockquote"""
        html = "<blockquote><ul><li>item1</li><li>item2</li></ul></blockquote>"
        result = _convert(html)
        assert "> - item1" in result
        assert "> - item2" in result

    def test_blockquote_containing_ordered_list(self) -> None:
        """EDGE-011: ordered list inside blockquote"""
        html = "<blockquote><ol><li>first</li><li>second</li></ol></blockquote>"
        result = _convert(html)
        assert "> 1. first" in result
        assert "> 2. second" in result


class TestCodeBlocks:
    """REQ-011: pre/code → fenced code blocks"""

    def test_fenced_code_block(self) -> None:
        html = "<pre><code>hello world</code></pre>"
        result = _convert(html)
        assert "```\nhello world\n```" in result

    def test_fenced_code_block_with_language(self) -> None:
        """EDGE-013: language class on code tag"""
        html = '<pre><code class="language-python">print("hi")</code></pre>'
        result = _convert(html)
        assert '```python\nprint("hi")\n```' in result

    def test_fenced_code_block_class_without_language_prefix(self) -> None:
        """EDGE-013: class without language- prefix"""
        html = '<pre><code class="python">x = 1</code></pre>'
        result = _convert(html)
        assert "```python\nx = 1\n```" in result

    def test_pre_without_code(self) -> None:
        html = "<pre>plain preformatted</pre>"
        result = _convert(html)
        assert "```\nplain preformatted\n```" in result

    def test_code_block_preserves_whitespace(self) -> None:
        html = "<pre><code>  indented\n    more</code></pre>"
        result = _convert(html)
        assert "  indented\n    more" in result

    def test_inline_code_not_fenced(self) -> None:
        """Inline code stays as backticks, not fenced"""
        result = _convert("<p>Use <code>x</code> here</p>")
        assert "`x`" in result
        assert "```" not in result


class TestTables:
    """REQ-014: table → pipe table"""

    def test_table_with_thead(self) -> None:
        html = """<table>
            <thead><tr><th>Name</th><th>Age</th></tr></thead>
            <tbody><tr><td>Alice</td><td>30</td></tr></tbody>
        </table>"""
        result = _convert(html)
        assert "| Name | Age |" in result
        assert "| --- | --- |" in result
        assert "| Alice | 30 |" in result

    def test_table_without_thead(self) -> None:
        """EDGE-002: no thead → first row becomes header"""
        html = """<table>
            <tr><td>Name</td><td>Age</td></tr>
            <tr><td>Bob</td><td>25</td></tr>
        </table>"""
        result = _convert(html)
        assert "| Name | Age |" in result
        assert "| --- | --- |" in result
        assert "| Bob | 25 |" in result

    def test_table_with_inline_formatting(self) -> None:
        """EDGE-012: inline formatting in table cells"""
        html = """<table>
            <thead><tr><th>Col</th></tr></thead>
            <tbody><tr><td><strong>bold</strong></td></tr></tbody>
        </table>"""
        result = _convert(html)
        assert "**bold**" in result

    def test_table_with_links_in_cells(self) -> None:
        """EDGE-012: links in table cells"""
        html = """<table>
            <thead><tr><th>Link</th></tr></thead>
            <tbody><tr><td><a href="https://x.com">click</a></td></tr></tbody>
        </table>"""
        result = _convert(html)
        assert "[click](https://x.com)" in result

    def test_table_varying_columns(self) -> None:
        html = """<table>
            <tr><td>A</td><td>B</td><td>C</td></tr>
            <tr><td>1</td><td>2</td><td>3</td></tr>
        </table>"""
        result = _convert(html)
        assert "| A | B | C |" in result
        assert "| 1 | 2 | 3 |" in result


class TestDefinitionLists:
    """REQ-017: dl/dt/dd → bold term + indented definition"""

    def test_basic_definition_list(self) -> None:
        html = "<dl><dt>Term</dt><dd>Definition</dd></dl>"
        result = _convert(html)
        assert "**Term**" in result
        assert ": Definition" in result

    def test_multiple_definitions(self) -> None:
        html = "<dl><dt>T1</dt><dd>D1</dd><dt>T2</dt><dd>D2</dd></dl>"
        result = _convert(html)
        assert "**T1**" in result
        assert ": D1" in result
        assert "**T2**" in result
        assert ": D2" in result
