#!/usr/bin/env python3
"""Extract a session's transcripts into small, readable files.

    python3 extract.py --out DIR [--session ID] [--main PATH] [--tz Asia/Kolkata]

With no --main and no --session it takes the project's newest session. Prints a one-screen
summary and writes numbered files to DIR. Read those files, not the transcripts.

The parsing lives in transcript.py, which any other script can import.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from transcript import (  # noqa: E402
    Clock,
    Session,
    blocks,
    body,
    human_span,
    text_of,
)

STAGE_TOOLS = ("Skill", "Agent", "Task")
CAP = 400


def w(out: str, name: str) -> "object":
    return open(os.path.join(out, name), "w")


def dump_spine(s: Session, out: str) -> tuple[int, int]:
    rows = s.human_messages()
    queued = sum(1 for m in rows if m.kind == "QUEUED")
    with w(out, "01-spine.txt") as f:
        f.write(f"# Human messages: {len(rows)} total, {queued} typed mid-action\n")
        f.write("# QUEUED = typed while the agent was working. Corrections live here.\n\n")
        for m in rows:
            f.write(f"===== {m.kind} main:{m.line} @ {m.at(s.clock)}\n{m.text[:2000]}\n\n")
    return len(rows), queued


def dump_assistant(s: Session, out: str) -> None:
    with w(out, "02-assistant.txt") as f:
        for i, d in s.recs:
            if d.get("type") != "assistant":
                continue
            for b in blocks(d, "text"):
                if b.get("text", "").strip():
                    f.write(f"===== main:{i} @ {s.clock.fmt(d)}\n{b['text']}\n\n")


def dump_calls(s: Session, out: str) -> Counter:
    names: Counter = Counter()
    with w(out, "03-tool-calls.txt") as f:
        for c in s.calls():
            names[c.name] += 1
            f.write(f"main:{c.line} | {s.clock.fmt(c.ts)} | {c.name} | "
                    f"{json.dumps(c.input)[:600]}\n")
    return names


def dump_failures(s: Session, out: str) -> tuple[int, Counter]:
    families: Counter = Counter()
    rows = s.failures()
    with w(out, "04-tool-errors.txt") as f:
        for r in rows:
            families[r.call.family if r.call else "?"] += 1
            origin = f"{r.call.name} (called main:{r.call.line})" if r.call else "?"
            inp = json.dumps(r.call.input)[:500] if r.call else ""
            f.write(f"===== main:{r.line} @ {s.clock.fmt(r.ts)} | {origin}\n"
                    f"INPUT: {inp}\nERROR: {r.text[:1200]}\n\n")
    return len(rows), families


def dump_questions(s: Session, out: str) -> int:
    asks = s.calls(["AskUserQuestion"])
    with w(out, "05-ask-user.txt") as f:
        for c in asks:
            f.write(f"===== ASK main:{c.line} @ {s.clock.fmt(c.ts)}\n"
                    f"{json.dumps(c.input, indent=1)[:3000]}\n\n")
        for call, line, answer in s.answers():
            asked = f" (asked main:{call.line})" if call else ""
            f.write(f"===== ANSWER main:{line}{asked}\n{answer[:2000]}\n\n")
    return len(asks)


def dump_agents(s: Session, out: str) -> tuple[int, list[str]]:
    agents = s.agents()
    dead: list[str] = []
    with w(out, "06-subagents.txt") as f:
        for a in agents:
            if a.died:
                dead.append(f"{a.name}:{a.final_line}")
            flag = "  *** DIED ON A PLATFORM LIMIT ***" if a.died else ""
            f.write(f"\n===== {a.name}{flag}\n  {a.description}\n"
                    f"  {s.clock.fmt(a.first)} -> {s.clock.fmt(a.last)} | "
                    f"errors={len(a.failures)} | {a.tools}\n")
            for r in a.failures[:12]:
                cmd = r.call.command[:160] if r.call else "?"
                f.write(f"   ERR {s.clock.fmt(r.ts)} | {cmd}\n       {r.text[:200]}\n")
            f.write(f"   FINAL :{a.final_line} {a.final_text[:200]}\n")
    return len(agents), dead


def dump_timeline(s: Session, out: str) -> int:
    gaps = {g.after_line: g for g in s.gaps()}
    with w(out, "07-timeline.txt") as f:
        f.write("# STAGE lines are stage boundaries. Classify every GAP before counting it:\n"
                "#   blocked-on-human | subagent-running | stall.  Only a stall is a defect.\n\n")
        for i, d in s.recs:
            g = gaps.get(i)
            if g:
                f.write(f"\nGAP {g.minutes}m  main:{g.before_line} -> main:{g.after_line}"
                        f"  (ends {s.clock.fmt(d)})\n"
                        f"  BEFORE {g.before_type}: {g.before_text[:200]}\n"
                        f"  AFTER  {g.after_type}: {g.after_text[:200]}\n"
                        f"  BRACKET: [ ] blocked-on-human  [ ] subagent-running  [ ] stall\n\n")
            for b in blocks(d, "tool_use"):
                if b.get("name") in STAGE_TOOLS:
                    inp = b.get("input") or {}
                    label = inp.get("skill") or inp.get("description") or ""
                    f.write(f"STAGE main:{i} @ {s.clock.fmt(d)} {b.get('name')} :: {label}\n")
    return len(gaps)


def dump_incidents(s: Session, out: str) -> int:
    rows = s.incidents()
    with w(out, "08-incidents.txt") as f:
        for line, ts, flag, value in rows:
            f.write(f"main:{line} @ {s.clock.fmt(ts)} | {flag} = {value}\n")
    return len(rows)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", required=True, help="scratch directory for the extractions")
    p.add_argument("--main", help="main session .jsonl; omit to discover")
    p.add_argument("--session", help="session id, resolved under the project's transcript dir")
    p.add_argument("--project", help="project working directory (default: cwd)")
    p.add_argument("--subagents", help="agent-*.jsonl directory (default: alongside main)")
    p.add_argument("--tz", help="IANA zone for displayed times, e.g. Asia/Kolkata")
    a = p.parse_args()

    s = Session.discover(a.main, a.session, a.project, a.subagents, a.tz)
    os.makedirs(a.out, exist_ok=True)

    dump_assistant(s, a.out)
    n_human, n_queued = dump_spine(s, a.out)
    calls = dump_calls(s, a.out)
    n_err, families = dump_failures(s, a.out)
    n_ask = dump_questions(s, a.out)
    n_agents, dead = dump_agents(s, a.out)
    n_gaps = dump_timeline(s, a.out)
    n_inc = dump_incidents(s, a.out)

    span = s.span()
    own_line, own_text = s.final_message()
    lines = [
        f"main             {s.main}",
        f"subagents        {s.subagents or 'none found'}",
        f"records          {sum(s.census().values())}  {dict(s.census())}",
    ]
    if span:
        lines.append(f"span             {s.clock.fmt(span[0].isoformat())} -> "
                     f"{s.clock.fmt(span[1].isoformat())}  "
                     f"({human_span(span[1] - span[0])}, {s.clock.name})")
    lines += [
        f"human messages   {n_human}  ({n_queued} typed mid-action -> 01-spine.txt)",
        f"AskUserQuestion  {n_ask}",
        f"sub-agents       {n_agents}",
        f"tool errors      {n_err}",
        f"incident flags   {n_inc}",
        f"gaps > 5 min     {n_gaps}  (classify each before counting a stall)",
        f"agent deaths     {len(dead)}" + (("  " + ", ".join(dead)) if dead else ""),
        "",
        "top error families:",
    ]
    lines += [f"  {n:>4}  {fam[:90]}" for fam, n in families.most_common(8)]
    lines += ["", "top tool calls:"]
    lines += [f"  {n:>4}  {name}" for name, n in calls.most_common(8)]

    text = "\n".join(lines)
    with w(a.out, "00-summary.txt") as f:
        f.write(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
