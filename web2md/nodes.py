from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class Node:
    tag: str
    attrs: dict[str, str] = field(default_factory=dict)
    children: list[Node] = field(default_factory=list)
    text: str | None = None

    @property
    def is_text_node(self) -> bool:
        return self.tag == "__text__"
