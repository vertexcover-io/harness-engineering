#!/usr/bin/env python3
"""Open one citation. Prints the record at a line number, in readable form.

Usage:
    python3 cite.py TRANSCRIPT.jsonl LINE [LINE ...] [--context N] [--tz ZONE] [--full]

A citation in the report reads `main:1234`. This turns that into the actual message,
command, or output, without opening the transcript.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo


def stamp(rec: dict[str, Any], zone: str | None) -> str:
    t = rec.get("timestamp")
    if not isinstance(t, str):
        return "?"
    try:
        d = datetime.fromisoformat(t.replace("Z", "+00:00"))
    except ValueError:
        return "?"
    tz = ZoneInfo(zone) if zone else datetime.now().astimezone().tzinfo
    return d.astimezone(tz).strftime("%m-%d %H:%M:%S")


def render(line: int, rec: dict[str, Any], zone: str | None, cap: int) -> str:
    head = f"--- {os.environ.get('CITE_LABEL', 'main')}:{line} @ {stamp(rec, zone)} [{rec.get('type')}]"
    body: list[str] = []
    c = (rec.get("message") or {}).get("content")

    if isinstance(c, str):
        body.append(c[:cap])
    elif isinstance(c, list):
        for b in c:
            if not isinstance(b, dict):
                continue
            kind = b.get("type")
            if kind == "text":
                body.append(b.get("text", "")[:cap])
            elif kind == "tool_use":
                body.append(f"[TOOL {b.get('name')}]\n{json.dumps(b.get('input'), indent=1)[:cap]}")
            elif kind == "tool_result":
                inner = b.get("content")
                txt = inner if isinstance(inner, str) else "\n".join(
                    x.get("text", "") for x in inner if isinstance(x, dict)
                ) if isinstance(inner, list) else ""
                flag = " ERROR" if b.get("is_error") else ""
                body.append(f"[RESULT{flag}]\n{txt[:cap]}")

    if not body:
        keys = {k: v for k, v in rec.items() if k not in ("message", "type", "timestamp")}
        body.append(json.dumps(keys, default=str)[:cap])
    return head + "\n" + "\n".join(body) + "\n"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("transcript")
    p.add_argument("lines", nargs="+", type=int)
    p.add_argument("--context", type=int, default=0, help="also show N records either side")
    p.add_argument("--tz", help="IANA zone, e.g. Asia/Kolkata")
    p.add_argument("--full", action="store_true", help="do not cap field length")
    a = p.parse_args()

    cap = 1_000_000 if a.full else 3000
    os.environ["CITE_LABEL"] = os.path.basename(a.transcript).split(".")[0][:20]

    wanted: set[int] = set()
    for n in a.lines:
        wanted.update(range(n - a.context, n + a.context + 1))

    with open(a.transcript, errors="replace") as f:
        for i, line in enumerate(f, 1):
            if i not in wanted:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                print(f"--- {i}: unparseable line")
                continue
            print(render(i, rec, a.tz, cap))


if __name__ == "__main__":
    main()
