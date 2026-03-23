from __future__ import annotations

from bs4 import BeautifulSoup, Tag

POSITIVE_PATTERNS = ("content", "article", "post", "body")
NEGATIVE_PATTERNS = ("nav", "sidebar", "footer", "header", "menu", "ad", "comment")
NEGATIVE_TAG_NAMES = frozenset({"nav", "aside", "footer", "header"})
NOISE_TAGS = frozenset({"script", "style"})
SCORE_PROPAGATION_FACTOR = 0.5
MIN_SCORE_THRESHOLD = 25.0


def _cleanup(soup: BeautifulSoup | Tag) -> None:
    for tag_name in NOISE_TAGS:
        for el in soup.find_all(tag_name):
            el.decompose()


def _get_class_id_text(tag: Tag) -> str:
    parts: list[str] = []
    cls = tag.get("class")
    if isinstance(cls, list):
        parts.extend(cls)
    tag_id = tag.get("id")
    if isinstance(tag_id, str):
        parts.append(tag_id)
    return " ".join(parts).lower()


def _direct_text_length(tag: Tag) -> int:
    total = 0
    for child in tag.children:
        if isinstance(child, str):
            total += len(child.strip())
    return total


def _count_p_children(tag: Tag) -> int:
    return len(tag.find_all("p", recursive=False))


def _link_text_length(tag: Tag) -> int:
    return sum(len(a.get_text(strip=True)) for a in tag.find_all("a"))


def _link_density(tag: Tag) -> float:
    total_text = len(tag.get_text(strip=True))
    if total_text == 0:
        return 0.0
    return _link_text_length(tag) / total_text


def _has_negative_ancestor(tag: Tag) -> bool:
    parent = tag.parent
    while parent and isinstance(parent, Tag):
        if parent.name in NEGATIVE_TAG_NAMES:
            return True
        class_id = _get_class_id_text(parent)
        for pattern in NEGATIVE_PATTERNS:
            if pattern in class_id:
                return True
        parent = parent.parent
    return False


def _score_element(tag: Tag) -> float:
    if _has_negative_ancestor(tag):
        return 0.0

    score = 0.0

    if tag.name == "article":
        score += 100

    if tag.name in NEGATIVE_TAG_NAMES:
        score -= 25

    class_id = _get_class_id_text(tag)
    for pattern in POSITIVE_PATTERNS:
        if pattern in class_id:
            score += 25
            break

    for pattern in NEGATIVE_PATTERNS:
        if pattern in class_id:
            score -= 25
            break

    score += _direct_text_length(tag)
    score += _count_p_children(tag) * 10

    density = _link_density(tag)
    if density > 0.5:
        score *= (1 - density)

    return score


def extract(soup: BeautifulSoup) -> Tag:
    _cleanup(soup)

    body = soup.find("body")
    if not isinstance(body, Tag):
        if isinstance(soup, Tag):
            return soup
        raise ValueError("No body element found")

    scores: dict[Tag, float] = {}

    for tag in body.find_all(True):
        if not isinstance(tag, Tag):
            continue
        scores[tag] = _score_element(tag)

    # Propagate scores upward
    for tag in body.find_all(True):
        if not isinstance(tag, Tag):
            continue
        parent = tag.parent
        if isinstance(parent, Tag) and parent in scores:
            child_score = scores.get(tag, 0)
            if child_score > 0:
                propagated = child_score * SCORE_PROPAGATION_FACTOR
                scores[parent] = scores.get(parent, 0) + propagated

    best_tag = body
    best_score = 0.0

    for tag, score in scores.items():
        if score > best_score:
            best_score = score
            best_tag = tag

    if best_score < MIN_SCORE_THRESHOLD:
        return body

    return best_tag
