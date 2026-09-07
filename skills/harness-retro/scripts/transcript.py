#!/usr/bin/env python3
"""Read any Claude Code session transcript.

Nothing here knows about retros. Import it from any script that needs to mine a session:

    import sys; sys.path.insert(0, '<skill>/scripts')
    from transcript import Session

    s = Session.discover(session_id='94f398c6-...')
    for m in s.human_messages():
        print(m.line, m.at(s.clock), m.kind, m.text[:80])

Layout it understands:
    ~/.claude/projects/SLUG/SESSION_ID.jsonl
    ~/.claude/projects/SLUG/SESSION_ID/subagents/agent-*.jsonl (+ .meta.json)
where SLUG is the project working directory with every "/" replaced by "-".
"""

from __future__ import annotations

import glob
import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Iterable, Iterator
from zoneinfo import ZoneInfo

Rec = tuple[int, dict[str, Any]]

WRAPPER_PREFIXES = (
    "[Request interrupted",
    "<task-notification",
    "<command-name",
    "<local-command",
    "<system-reminder",
    "Caveat:",
    "Base directory for this skill",
)

INCIDENT_FLAGS = (
    "error",
    "isApiErrorMessage",
    "apiErrorStatus",
    "interruptedMessageId",
    "isAbortedMidStream",
    "toolDenialKind",
    "preventedContinuation",
    "hookErrors",
)

ERROR_TEXT = re.compile(
    r"command not found|ENOENT|EADDRINUSE|MODULE_NOT_FOUND|npm ERR|fatal:|"
    r"No such file|Permission denied|Traceback|error TS\d+",
    re.I,
)

LIMIT_BANNER = re.compile(r"session limit|rate.?limit|usage limit", re.I)

PLAN_ARTIFACT = re.compile(r"^plan\.(md|html)$", re.I)


# ---------------------------------------------------------------- primitives


def load(path: str) -> list[Rec]:
    """Every parseable line, paired with its 1-based number. The number is the citation."""
    out: list[Rec] = []
    with open(path, errors="replace") as f:
        for i, line in enumerate(f, 1):
            try:
                out.append((i, json.loads(line)))
            except json.JSONDecodeError:
                pass
    return out


def blocks(rec: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    c = (rec.get("message") or {}).get("content")
    if isinstance(c, list):
        return [b for b in c if isinstance(b, dict) and b.get("type") == kind]
    return []


def text_of(content: Any) -> str:
    """Flatten a content value to its plain text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            x.get("text", "")
            for x in content
            if isinstance(x, dict) and x.get("type") == "text"
        )
    return ""


def body(rec: dict[str, Any]) -> str:
    return text_of((rec.get("message") or {}).get("content"))


def is_wrapper(text: str) -> bool:
    """True for text that only looks like a human message.

    Includes `[Request interrupted by user]`, which is a marker the client writes, not
    something anyone typed. Interrupts are real incidents — detector D6 reads them from the
    incident flags, where they carry their own record.
    """
    return any(text.startswith(p) for p in WRAPPER_PREFIXES)


def human_span(delta: timedelta) -> str:
    mins = int(delta.total_seconds() // 60)
    return f"{mins // 60}h {mins % 60:02d}m" if mins >= 60 else f"{mins}m"


class Clock:
    """Formats UTC transcript timestamps in one target timezone."""

    def __init__(self, zone: str | None = None) -> None:
        self.tz = ZoneInfo(zone) if zone else datetime.now().astimezone().tzinfo
        self.name = zone or datetime.now().astimezone().strftime("%Z%z")

    def parse(self, value: Any) -> datetime | None:
        t = value.get("timestamp") if isinstance(value, dict) else value
        if not isinstance(t, str):
            return None
        try:
            return datetime.fromisoformat(t.replace("Z", "+00:00"))
        except ValueError:
            return None

    def fmt(self, value: Any, pattern: str = "%m-%d %H:%M:%S") -> str:
        d = self.parse(value)
        return d.astimezone(self.tz).strftime(pattern) if d else "?"


# ---------------------------------------------------------------- structures


@dataclass
class Message:
    line: int
    ts: str
    kind: str  # TYPED = agent was idle; QUEUED = typed while the agent worked
    text: str

    def at(self, clock: Clock) -> str:
        return clock.fmt(self.ts)


@dataclass
class Call:
    line: int
    ts: str
    name: str
    input: Any

    @property
    def command(self) -> str:
        if isinstance(self.input, dict):
            return str(self.input.get("command") or self.input.get("file_path") or "")
        return ""

    @property
    def family(self) -> str:
        """First two tokens of the command — the unit for clustering repeated failures."""
        return " ".join(self.command.split()[:2]) or self.name


@dataclass
class Failure:
    line: int
    ts: str
    call: Call | None
    text: str


@dataclass
class Gap:
    before_line: int
    after_line: int
    minutes: int
    before_type: str
    before_text: str
    after_type: str
    after_text: str


@dataclass
class Agent:
    path: str
    name: str
    description: str
    first: str
    last: str
    tools: dict[str, int]
    failures: list[Failure]
    died: bool
    final_line: int
    final_text: str


# ---------------------------------------------------------------- discovery


def project_dir(cwd: str | None = None) -> str:
    slug = os.path.abspath(cwd or os.getcwd()).replace("/", "-")
    return os.path.expanduser(f"~/.claude/projects/{slug}")


def list_sessions(cwd: str | None = None) -> list[str]:
    """Every session transcript for a project, oldest first."""
    return sorted(glob.glob(os.path.join(project_dir(cwd), "*.jsonl")), key=os.path.getmtime)


# ---------------------------------------------------------------- session


class Session:
    """One session transcript plus its sub-agents."""

    def __init__(self, main: str, subagents: str | None = None,
                 tz: str | None = None) -> None:
        if not os.path.exists(main):
            raise FileNotFoundError(main)
        self.main = main
        self.id = os.path.basename(main)[: -len(".jsonl")]
        if subagents is None:
            guess = os.path.join(main[: -len(".jsonl")], "subagents")
            subagents = guess if os.path.isdir(guess) else None
        self.subagents = subagents
        self.clock = Clock(tz)
        self.recs = load(main)

    @classmethod
    def discover(cls, main: str | None = None, session_id: str | None = None,
                 cwd: str | None = None, subagents: str | None = None,
                 tz: str | None = None) -> "Session":
        """Find a transcript from a path, a session id, or the project's newest session."""
        if not main:
            if session_id:
                main = os.path.join(project_dir(cwd), f"{session_id}.jsonl")
            else:
                found = list_sessions(cwd)
                if not found:
                    raise FileNotFoundError(f"no transcripts under {project_dir(cwd)}")
                main = found[-1]
        return cls(main, subagents, tz)

    # -- shape ----------------------------------------------------

    def census(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for _, d in self.recs:
            k = str(d.get("type"))
            out[k] = out.get(k, 0) + 1
        return out

    def span(self) -> tuple[datetime, datetime] | None:
        stamps = [t for t in (self.clock.parse(d) for _, d in self.recs) if t]
        return (stamps[0], stamps[-1]) if len(stamps) > 1 else None

    # -- humans ---------------------------------------------------

    def human_messages(self) -> list[Message]:
        """Every message the human sent, from both places they land.

        A plain `user` record holds text sent while the agent was idle. Text typed while the
        agent worked lands instead in an `attachment` (`queued_command`) or a
        `queue-operation` record, and the two sets overlap without either containing the
        other. Queued text is scanned first so a message present in both keeps the QUEUED
        label — mid-action is the fact worth keeping, because corrections live there.
        """
        rows: list[Message] = []
        seen: set[str] = set()

        def keep(line: int, ts: str, kind: str, raw: str) -> None:
            t = raw.strip()
            if not t or is_wrapper(t) or t[:200] in seen:
                return
            seen.add(t[:200])
            rows.append(Message(line, ts, kind, t))

        for i, d in self.recs:
            a = d.get("attachment") or {}
            if (d.get("type") == "attachment" and a.get("type") == "queued_command"
                    and (a.get("origin") or {}).get("kind") == "human"):
                keep(i, d.get("timestamp", ""), "QUEUED", a.get("prompt", ""))
            elif (d.get("type") == "queue-operation"
                  and d.get("operation") in ("enqueue", "remove")
                  and isinstance(d.get("content"), str)):
                keep(i, d.get("timestamp", ""), "QUEUED", d["content"])

        for i, d in self.recs:
            if d.get("type") != "user" or d.get("isMeta") or blocks(d, "tool_result"):
                continue
            c = (d.get("message") or {}).get("content")
            texts = [c] if isinstance(c, str) else [b.get("text", "") for b in blocks(d, "text")]
            for t in texts:
                keep(i, d.get("timestamp", ""), "TYPED", t)

        rows.sort(key=lambda m: (m.ts, m.line))
        return rows

    # -- tools ----------------------------------------------------

    def calls(self, names: Iterable[str] | None = None) -> list[Call]:
        want = set(names) if names else None
        out: list[Call] = []
        for i, d in self.recs:
            if d.get("type") != "assistant":
                continue
            for b in blocks(d, "tool_use"):
                if want and b.get("name") not in want:
                    continue
                out.append(Call(i, d.get("timestamp", ""), b.get("name", "?"), b.get("input")))
        return out

    def call_index(self) -> dict[str, Call]:
        idx: dict[str, Call] = {}
        for i, d in self.recs:
            if d.get("type") != "assistant":
                continue
            for b in blocks(d, "tool_use"):
                idx[b["id"]] = Call(i, d.get("timestamp", ""), b.get("name", "?"), b.get("input"))
        return idx

    def failures(self) -> list[Failure]:
        """Tool results flagged as errors, plus results whose text reads like one."""
        idx = self.call_index()
        out: list[Failure] = []
        for i, d in self.recs:
            if d.get("type") != "user":
                continue
            for b in blocks(d, "tool_result"):
                txt = text_of(b.get("content"))
                if not b.get("is_error") and not ERROR_TEXT.search(txt[:2000]):
                    continue
                out.append(Failure(i, d.get("timestamp", ""), idx.get(b.get("tool_use_id")), txt))
        return out

    def answers(self) -> list[tuple[Call | None, int, str]]:
        """Each AskUserQuestion paired with the answer that came back."""
        idx = self.call_index()
        ask_ids = {k for k, v in idx.items() if v.name == "AskUserQuestion"}
        out = []
        for i, d in self.recs:
            for b in blocks(d, "tool_result"):
                if b.get("tool_use_id") in ask_ids:
                    out.append((idx.get(b["tool_use_id"]), i, text_of(b.get("content"))))
        return out

    # -- time -----------------------------------------------------

    def gaps(self, seconds: int = 300) -> list[Gap]:
        """Every pause longer than `seconds`, with both sides.

        A gap is not a stall. The caller decides which of blocked-on-human,
        sub-agent-running, or stall applies, by looking at what sat on each side.
        """
        out: list[Gap] = []
        prev: tuple[datetime, int, str, str] | None = None
        for i, d in self.recs:
            t = self.clock.parse(d)
            if not t:
                continue
            if prev and (t - prev[0]).total_seconds() > seconds:
                out.append(Gap(prev[1], i, int((t - prev[0]).total_seconds() // 60),
                               prev[2], prev[3], str(d.get("type")), body(d)))
            prev = (t, i, str(d.get("type")), body(d))
        return out

    def incidents(self) -> list[tuple[int, str, str, str]]:
        out = []
        for i, d in self.recs:
            for flag in INCIDENT_FLAGS:
                if d.get(flag):
                    out.append((i, d.get("timestamp", ""), flag, str(d.get(flag))[:200]))
            if d.get("type") == "pr-link":
                out.append((i, d.get("timestamp", ""), "pr-link",
                            f"#{d.get('prNumber')} {d.get('prUrl')}"))
        return out

    # -- sub-agents -----------------------------------------------

    def agent_paths(self) -> list[str]:
        if not self.subagents:
            return []
        return sorted(glob.glob(os.path.join(self.subagents, "agent-*.jsonl")))

    def agents(self) -> list[Agent]:
        out = [read_agent(p) for p in self.agent_paths()]
        out.sort(key=lambda a: a.first)
        return out

    def final_message(self) -> tuple[int, str]:
        return final_message(self.main)

    def plan_gate(self) -> int | None:
        """Line of the last write to a plan artifact — the gate the pipeline promises to
        run past without stopping. Everything after it is post-gate.

        Returns the line of the human approval that follows the last plan write. Returns
        None when no plan artifact was written (an atomic run, or a different pipeline);
        the caller then sets the line itself.
        """
        last: int | None = None
        for c in self.calls(("Write", "Edit")):
            path = c.input.get("file_path", "") if isinstance(c.input, dict) else ""
            if PLAN_ARTIFACT.search(os.path.basename(str(path))):
                last = c.line
        if last is None:
            return None
        # The gate is the approval, not the write. "looks good, go" is the last legitimate
        # human message of the run; everything after it breaks the no-stopping contract.
        for m in self.human_messages():
            if m.line > last:
                return m.line
        return last


def final_message(path: str) -> tuple[int, str]:
    for i, d in reversed(load(path)):
        if d.get("type") == "assistant" and blocks(d, "text"):
            return i, blocks(d, "text")[-1].get("text", "").strip()
    return 0, ""


def died_on_limit(text: str) -> bool:
    """A platform banner leads a short message.

    Matching anywhere in the text produces false positives: a long closing report that
    mentions a rate limit is not a death.
    """
    return bool(LIMIT_BANNER.search(text[:200])) and len(text) < 500


def read_agent(path: str) -> Agent:
    meta_path = path.replace(".jsonl", ".meta.json")
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    first = last = ""
    tools: dict[str, int] = {}
    inputs: dict[str, Any] = {}
    failures: list[Failure] = []
    for i, r in load(path):
        ts = r.get("timestamp") or ""
        if ts:
            first = first or ts
            last = ts
        for b in blocks(r, "tool_use"):
            name = b.get("name", "?")
            tools[name] = tools.get(name, 0) + 1
            inputs[b["id"]] = (i, ts, name, b.get("input", {}))
        for b in blocks(r, "tool_result"):
            if not b.get("is_error"):
                continue
            c = inputs.get(b.get("tool_use_id"))
            call = Call(*c) if c else None
            failures.append(Failure(i, ts, call, text_of(b.get("content"))))
    line, text = final_message(path)
    return Agent(path, os.path.basename(path), meta.get("description", "?"), first, last,
                 tools, failures, died_on_limit(text), line, text)
