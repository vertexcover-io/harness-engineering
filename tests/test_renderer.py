from web2md.tree_builder import parse_html
from web2md.renderer import render


# REQ-003: Headings h1-h6 produce correct # levels
def test_h1_heading() -> None:
    root = parse_html("<h1>Title</h1>")
    assert render(root) == "# Title"


def test_h2_heading() -> None:
    root = parse_html("<h2>Sub</h2>")
    assert render(root) == "## Sub"


def test_h6_heading() -> None:
    root = parse_html("<h6>Deep</h6>")
    assert render(root) == "###### Deep"


# REQ-004: Paragraphs separated by blank lines
def test_paragraphs_separated_by_blank_lines() -> None:
    root = parse_html("<p>First</p><p>Second</p>")
    assert render(root) == "First\n\nSecond"


def test_single_paragraph() -> None:
    root = parse_html("<p>Hello world</p>")
    assert render(root) == "Hello world"


# REQ-007: Unordered list items with - prefix
def test_unordered_list() -> None:
    root = parse_html("<ul><li>A</li><li>B</li></ul>")
    assert render(root) == "- A\n- B"


# REQ-008: Ordered list items with 1. 2. prefix
def test_ordered_list() -> None:
    root = parse_html("<ol><li>A</li><li>B</li></ol>")
    assert render(root) == "1. A\n2. B"


# REQ-009: Nested lists indented by 2 spaces per level
def test_nested_unordered_list() -> None:
    root = parse_html("<ul><li>A<ul><li>B</li></ul></li></ul>")
    assert render(root) == "- A\n  - B"


# EDGE-002: Deeply nested list (3+ levels)
def test_deeply_nested_list() -> None:
    root = parse_html("<ul><li>A<ul><li>B<ul><li>C</li></ul></li></ul></li></ul>")
    assert render(root) == "- A\n  - B\n    - C"


# EDGE-014: Mixed ordered and unordered nested lists
def test_mixed_nested_lists() -> None:
    root = parse_html("<ul><li>A<ol><li>One</li><li>Two</li></ol></li></ul>")
    assert render(root) == "- A\n  1. One\n  2. Two"


# REQ-015: Blockquote prefixed with >
def test_blockquote() -> None:
    root = parse_html("<blockquote>Quote</blockquote>")
    assert render(root) == "> Quote"


# EDGE-013: Blockquote containing a list
def test_blockquote_with_list() -> None:
    root = parse_html("<blockquote><ul><li>A</li><li>B</li></ul></blockquote>")
    assert render(root) == "> - A\n> - B"


# REQ-014: <pre><code> produces fenced code block
def test_pre_code_block() -> None:
    root = parse_html("<pre><code>x = 1</code></pre>")
    assert render(root) == "```\nx = 1\n```"


# EDGE-008: Whitespace preserved inside pre blocks
def test_pre_preserves_whitespace() -> None:
    root = parse_html("<pre><code>  line1\n  line2</code></pre>")
    assert render(root) == "```\n  line1\n  line2\n```"


# REQ-017: <hr> produces ---
def test_hr() -> None:
    root = parse_html("<p>Before</p><hr><p>After</p>")
    assert render(root) == "Before\n\n---\n\nAfter"


# REQ-024: <br> produces newline
def test_br() -> None:
    root = parse_html("<p>Line1<br>Line2</p>")
    assert render(root) == "Line1\nLine2"


# Unknown tags pass through (children rendered)
def test_unknown_tag_passthrough() -> None:
    root = parse_html("<div><span>Hello</span></div>")
    assert render(root) == "Hello"


# REQ-023: No trailing whitespace, no 3+ consecutive blank lines
def test_clean_output_no_trailing_whitespace() -> None:
    root = parse_html("<p>Hello  </p>")
    result = render(root)
    for line in result.split("\n"):
        assert line == line.rstrip()


def test_clean_output_no_triple_blank_lines() -> None:
    root = parse_html("<p>A</p><p></p><p></p><p>B</p>")
    result = render(root)
    assert "\n\n\n" not in result


# REQ-022: Whitespace collapsed in inline context
def test_whitespace_collapsed_inline() -> None:
    root = parse_html("<p>  hello   world  </p>")
    assert render(root) == "hello world"


# REQ-010: Bold with <strong>
def test_bold_strong() -> None:
    root = parse_html("<p><strong>text</strong></p>")
    assert render(root) == "**text**"


# REQ-010: Bold with <b>
def test_bold_b() -> None:
    root = parse_html("<p><b>text</b></p>")
    assert render(root) == "**text**"


# REQ-011: Italic with <em>
def test_italic_em() -> None:
    root = parse_html("<p><em>text</em></p>")
    assert render(root) == "*text*"


# REQ-011: Italic with <i>
def test_italic_i() -> None:
    root = parse_html("<p><i>text</i></p>")
    assert render(root) == "*text*"


# REQ-012: Strikethrough with <del>
def test_strikethrough_del() -> None:
    root = parse_html("<p><del>text</del></p>")
    assert render(root) == "~~text~~"


# REQ-012: Strikethrough with <s>
def test_strikethrough_s() -> None:
    root = parse_html("<p><s>text</s></p>")
    assert render(root) == "~~text~~"


# REQ-013: Inline code
def test_inline_code() -> None:
    root = parse_html("<p><code>x</code></p>")
    assert render(root) == "`x`"


# REQ-005: Links
def test_link() -> None:
    root = parse_html('<p><a href="https://example.com">click</a></p>')
    assert render(root) == "[click](https://example.com)"


# REQ-006: Images
def test_image() -> None:
    root = parse_html('<p><img src="pic.png" alt="photo"></p>')
    assert render(root) == "![photo](pic.png)"


# EDGE-001: Nested inline formatting bold+italic
def test_nested_bold_italic() -> None:
    root = parse_html("<p><b><i>text</i></b></p>")
    assert render(root) == "***text***"


# EDGE-012: Link with nested bold
def test_link_with_bold() -> None:
    root = parse_html('<p><a href="x"><b>bold</b></a></p>')
    assert render(root) == "[**bold**](x)"


# EDGE-006: Empty bold produces no output
def test_empty_bold() -> None:
    root = parse_html("<p><b></b></p>")
    assert render(root) == ""


# EDGE-006: Empty italic produces no output
def test_empty_italic() -> None:
    root = parse_html("<p><em></em></p>")
    assert render(root) == ""


# EDGE-006: Empty link produces no output
def test_empty_link() -> None:
    root = parse_html('<p><a href="x"></a></p>')
    assert render(root) == ""


# EDGE-006: Empty strikethrough produces no output
def test_empty_strikethrough() -> None:
    root = parse_html("<p><del></del></p>")
    assert render(root) == ""


# EDGE-006: Empty inline code produces no output
def test_empty_inline_code() -> None:
    root = parse_html("<p><code></code></p>")
    assert render(root) == ""


# EDGE-011: Image with no alt attribute
def test_image_no_alt() -> None:
    root = parse_html('<p><img src="x"></p>')
    assert render(root) == "![](x)"


# EDGE-006: Image with no src produces no output
def test_image_no_src() -> None:
    root = parse_html('<p><img alt="desc"></p>')
    assert render(root) == ""


# REQ-005: Link with no href produces no output
def test_link_no_href() -> None:
    root = parse_html("<p><a>text</a></p>")
    assert render(root) == ""


# REQ-016: Simple table with header and data rows
def test_simple_table() -> None:
    root = parse_html(
        "<table>"
        "<thead><tr><th>Name</th><th>Age</th></tr></thead>"
        "<tbody><tr><td>Alice</td><td>30</td></tr></tbody>"
        "</table>"
    )
    assert render(root) == "| Name | Age |\n| --- | --- |\n| Alice | 30 |"


# REQ-016: Table without explicit thead
def test_table_no_thead() -> None:
    root = parse_html(
        "<table>"
        "<tr><td>A</td><td>B</td></tr>"
        "<tr><td>C</td><td>D</td></tr>"
        "</table>"
    )
    assert render(root) == "| A | B |\n| --- | --- |\n| C | D |"


# EDGE-003: Table with colspan (ignored, content rendered)
def test_table_with_colspan() -> None:
    root = parse_html(
        "<table>"
        '<tr><th colspan="2">Header</th></tr>'
        "<tr><td>A</td><td>B</td></tr>"
        "</table>"
    )
    assert render(root) == "| Header |\n| --- |\n| A | B |"


# REQ-013: Inline code not inside pre (standalone)
def test_inline_code_in_paragraph_with_text() -> None:
    root = parse_html("<p>Use <code>var</code> here</p>")
    assert render(root) == "Use `var` here"


# Mixed inline in paragraph
def test_mixed_inline_in_paragraph() -> None:
    root = parse_html("<p>This is <b>bold</b> and <i>italic</i> text</p>")
    assert render(root) == "This is **bold** and *italic* text"
