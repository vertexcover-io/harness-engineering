from web2md.nodes import Node
from web2md.tree_builder import parse_html


def test_node_creation_with_defaults() -> None:
    node = Node(tag="div")
    assert node.tag == "div"
    assert node.attrs == {}
    assert node.children == []
    assert node.text is None


def test_node_is_text_node() -> None:
    text_node = Node(tag="__text__", text="hello")
    assert text_node.is_text_node is True
    div_node = Node(tag="div")
    assert div_node.is_text_node is False


# REQ-002: Simple HTML produces correct tree structure
def test_simple_html_tree_structure() -> None:
    root = parse_html("<h1>Hello</h1>")
    assert root.tag == "__root__"
    assert len(root.children) == 1
    h1 = root.children[0]
    assert h1.tag == "h1"
    assert len(h1.children) == 1
    assert h1.children[0].is_text_node
    assert h1.children[0].text == "Hello"


# REQ-002: Nested elements produce correct depth
def test_nested_elements() -> None:
    root = parse_html("<div><p>Text</p></div>")
    div = root.children[0]
    assert div.tag == "div"
    p = div.children[0]
    assert p.tag == "p"
    assert p.children[0].text == "Text"


# REQ-002: Empty input produces root with no children
def test_empty_input() -> None:
    root = parse_html("")
    assert root.tag == "__root__"
    assert root.children == []


# EDGE-007: Void elements don't push to stack
def test_void_elements_no_stack_corruption() -> None:
    root = parse_html("<p>Line1<br>Line2</p>")
    p = root.children[0]
    assert p.tag == "p"
    assert len(p.children) == 3
    assert p.children[0].text == "Line1"
    assert p.children[1].tag == "br"
    assert p.children[2].text == "Line2"


# EDGE-007: img is a void element
def test_img_void_element() -> None:
    root = parse_html('<p><img src="pic.png" alt="photo">text</p>')
    p = root.children[0]
    assert p.children[0].tag == "img"
    assert p.children[0].attrs == {"src": "pic.png", "alt": "photo"}
    assert p.children[1].text == "text"


# EDGE-007: hr is a void element
def test_hr_void_element() -> None:
    root = parse_html("<p>Before</p><hr><p>After</p>")
    assert root.children[0].tag == "p"
    assert root.children[1].tag == "hr"
    assert root.children[2].tag == "p"


# REQ-018: Script and style content stripped
def test_strip_script_content() -> None:
    root = parse_html("<div><script>alert(1)</script>Text</div>")
    div = root.children[0]
    assert len(div.children) == 1
    assert div.children[0].text == "Text"


# REQ-018: Style content stripped
def test_strip_style_content() -> None:
    root = parse_html("<div><style>body{color:red}</style>Text</div>")
    div = root.children[0]
    assert len(div.children) == 1
    assert div.children[0].text == "Text"


# REQ-018: Nav, footer, header stripped
def test_strip_nav_footer_header() -> None:
    root = parse_html("<nav>Nav</nav><div>Content</div><footer>Foot</footer>")
    assert len(root.children) == 1
    assert root.children[0].tag == "div"


# EDGE-016: HTML with only script and style
def test_script_only_page() -> None:
    root = parse_html("<html><head><script>x</script><style>y</style></head><body></body></html>")
    body = None
    for child in root.children:
        if child.tag == "html":
            for c in child.children:
                if c.tag == "body":
                    body = c
    assert body is not None
    assert body.children == []


# REQ-019: Named entity decoding
def test_named_entity_decoding() -> None:
    root = parse_html("<p>&amp; &lt; &gt;</p>")
    p = root.children[0]
    texts = [c.text for c in p.children if c.is_text_node and c.text is not None]
    combined = "".join(texts)
    assert "&" in combined
    assert "<" in combined
    assert ">" in combined


# REQ-019: Numeric entity decoding
def test_numeric_entity_decoding() -> None:
    root = parse_html("<p>&#8217;</p>")
    p = root.children[0]
    texts = [c.text for c in p.children if c.is_text_node and c.text is not None]
    combined = "".join(texts)
    assert "\u2019" in combined


# EDGE-009: Unclosed p tags implicitly closed
def test_unclosed_p_tags() -> None:
    root = parse_html("<p>First<p>Second")
    p_tags = [c for c in root.children if c.tag == "p"]
    assert len(p_tags) == 2
    assert p_tags[0].children[0].text == "First"
    assert p_tags[1].children[0].text == "Second"


# EDGE-009: Unclosed li tags
def test_unclosed_li_tags() -> None:
    root = parse_html("<ul><li>A<li>B</ul>")
    ul = root.children[0]
    li_tags = [c for c in ul.children if c.tag == "li"]
    assert len(li_tags) == 2
    assert li_tags[0].children[0].text == "A"
    assert li_tags[1].children[0].text == "B"


# REQ-002: Attributes are captured
def test_attributes_captured() -> None:
    root = parse_html('<a href="https://example.com">link</a>')
    a = root.children[0]
    assert a.tag == "a"
    assert a.attrs["href"] == "https://example.com"


# REQ-018: Nested strip tags
def test_nested_strip_tags() -> None:
    root = parse_html("<script><script>inner</script></script><p>OK</p>")
    assert root.children[0].tag == "p"
