#!/usr/bin/env python3
"""Deterministic half of the skill-review rubric.

Every check here is mechanical: same input, same finding, no model judgment.
Run this before the judgment pass so the model never spends tokens counting
lines or matching regexes.

Usage:
    python3 check.py <skill-path>            human summary
    python3 check.py <skill-path> --json     findings as JSON on stdout

Exit code is 1 when any blocker fires, so CI can gate on it.
No third-party dependencies: frontmatter is parsed with regex because pyyaml
is not guaranteed to be present.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

MAX_NAME = 64
MAX_DESCRIPTION = 1024
MAX_BODY_LINES = 500
TOC_REQUIRED_OVER = 100

BLOCK, MAJOR, MINOR = "blocker", "major", "minor"

VAGUE_NAMES = {"helper", "helpers", "utils", "util", "tools", "data", "files", "misc", "stuff"}
RESERVED = ("anthropic", "claude")
LAZY_FILENAMES = re.compile(r"^(doc|file|page|notes?|temp|tmp|untitled|new)[-_]?\d*\.md$", re.I)

FIRST_PERSON = re.compile(r"\b(I|I'm|I'll|we|we'll|our)\b", re.I)
SECOND_PERSON = re.compile(r"\byou(r|'ll|'re)?\b", re.I)
# A trigger list quotes what a user says, and "can we merge" is first person by construction.
# Person is a property of the skill's own prose, so quoted utterances come out before the test.
QUOTED_SPAN = re.compile(r"\"[^\"\n]*\"|“[^”\n]*”|‘[^’\n]*’")

WINDOWS_PATH = re.compile(r"[\w.-]+\\[\w.-]+\.(md|py|sh|json|ts|tsx|js)")
TIME_SENSITIVE = re.compile(
    r"\b(as of|before|after|until|since)\s+"
    r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4]|20\d\d)",
    re.I,
)
SPEC_SMELL = re.compile(r"\bverified\s+20\d\d[-/]\d\d\b|\blast checked\s+20\d\d\b", re.I)
HARDCODED_ID = re.compile(r"\b(?:[0-9a-f]{24,}|\d{12,})\b")

INSECURE = re.compile(
    r"curl\s[^\n|]*(-k\b|--insecure)"
    r"|verify\s*=\s*False"
    r"|rejectUnauthorized\s*:\s*false"
    r"|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0"
    r"|GIT_SSL_NO_VERIFY",  # skill-review: allow - this is the pattern table itself
    re.I,
)
SECRET_PARTS = {"token", "secret", "password", "passwd", "credential", "credentials", "pat"}
SECRET_PAIRS = {("api", "key"), ("private", "key"), ("access", "key"), ("secret", "key")}
PRINTER = re.compile(r"\b(?:echo|print|printf|console\.log)\b")
# `$VAR`, `${VAR}`, or a bare identifier. The sigil is captured separately because it is one of
# the signals that a word is a variable at all.
NAME_REF = re.compile(r"(\$\{?)?\b([A-Za-z_][A-Za-z0-9_]*)\b")
# A real leak writes the secret somewhere durable. Discards (/dev/null) and file-descriptor
# redirects (2>, 2>&1) carry no payload, and matching them produced false positives on scripts
# that merely mention a token-shaped variable.
# `->` and `=>` are not redirects: a python return type read as one turned every signature
# naming a secret into a credential write.
WRITE_TARGET = re.compile(r"(?<![\d=<>-])>>?\s*(?!/dev/null|&\d)\S+|\|\s*tee\b")
SCRIPT_SUFFIXES = {".py", ".sh", ".js", ".ts"}
TEST_FILENAME = re.compile(r"(^|[._-])(test|tests|spec)([._-]|$)", re.I)
# Deliberately bad code belongs in a scanner's own fixtures. This marker says so on the line
# itself, so the exemption is visible where it applies instead of hidden in an ignore list.
ALLOW_LINE = re.compile(r"skill-review:\s*allow\b")

VAR_REF = re.compile(r"\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)")
VOODOO = re.compile(r"^\s*([A-Z][A-Z0-9_]{2,})\s*[:=]\s*(\d+)\s*$")

MENU = re.compile(
    r"\bor\b[^.\n]{0,40}\bor\b[^.\n]{0,40}\bor\b"
    r"|\b(both|either) (work|works|are fine|is fine|options?)\b"
    r"|\byou (can|could) (use|pick|choose) [^.\n]{0,30}\bor\b",
    re.I,
)

# Local markdown links only. An external URL that happens to end in .md is a citation, not a
# bundled reference file, and treating it as one produced a false nested-reference finding.
MD_LINK = re.compile(r"\[[^\]]*\]\((?!\w+://)([^)#][^)]*\.md)\)")
# A skill may cite a reference as a backticked path or a bare relative path instead of a link.
# Counting only link syntax reported every such citation as an orphan.
MD_MENTION = re.compile(r"[\w./-]*[\w.-]+\.md\b")
URL = re.compile(r"\w+://\S+")
FENCE = re.compile(r"^```([a-zA-Z0-9_+-]*)\s*$")


@dataclass
class Finding:
    id: str
    category: str
    finding_type: str
    severity: str
    location: str
    evidence: str
    fix: str
    deterministic: bool = True


class Checker:
    def __init__(self, root: Path):
        self.root = root
        self.findings: list[Finding] = []
        self.skill_md = root / "SKILL.md"

    def add(self, id_, category, ftype, severity, location, evidence, fix):
        self.findings.append(
            Finding(id_, category, ftype, severity, location, squash(evidence), fix)
        )

    # ---------- frontmatter ----------

    def check_frontmatter(self, raw: str) -> tuple[dict[str, str], str, int]:
        m = re.match(r"^---\n(.*?)\n---\n?", raw, re.S)
        if not m:
            self.add(
                "N1", "convention", "missing_frontmatter", BLOCK,
                "SKILL.md:1", raw.splitlines()[0] if raw.strip() else "(empty file)",
                "Add YAML frontmatter with `name` and `description`.",
            )
            return {}, raw, 0
        fm = parse_frontmatter(m.group(1))
        body = raw[m.end():]
        offset = raw[: m.end()].count("\n")

        name = fm.get("name", "")
        if not name:
            self.add("N1", "convention", "missing_name", BLOCK, "SKILL.md:2", "(no name)",
                     "Add a `name` field.")
        else:
            if len(name) > MAX_NAME:
                self.add("N1", "convention", "name_too_long", BLOCK, "SKILL.md:name",
                         f"{len(name)} chars", f"Trim to {MAX_NAME} characters or fewer.")
            if not re.fullmatch(r"[a-z0-9-]+", name):
                self.add("N1", "convention", "name_bad_charset", BLOCK, "SKILL.md:name", name,
                         "Use lowercase letters, digits and hyphens only.")
            if any(w in name.lower() for w in RESERVED):
                self.add("N1", "convention", "name_reserved_word", BLOCK, "SKILL.md:name", name,
                         'Remove the reserved words "anthropic" and "claude".')
            if name.lower() in VAGUE_NAMES or name.lower().split("-")[-1] in VAGUE_NAMES:
                self.add("N3", "convention", "name_vague", MAJOR, "SKILL.md:name", name,
                         "Name the activity, not a bucket. Prefer gerund form.")
            # N2 (gerund naming) was retired: noun phrases are an accepted alternative, so it
            # fired on nearly every real skill and discriminated nothing.

        desc = fm.get("description", "")
        if not desc:
            self.add("D1", "description", "missing_description", BLOCK, "SKILL.md:3", "(no description)",
                     "Add a description saying what the skill does and when to use it.")
        else:
            if len(desc) > MAX_DESCRIPTION:
                self.add("D1", "description", "description_too_long", BLOCK, "SKILL.md:description",
                         f"{len(desc)} chars", f"Trim to {MAX_DESCRIPTION} characters.")
            if "<" in desc and ">" in desc:
                self.add("D1", "description", "description_has_xml", BLOCK, "SKILL.md:description",
                         desc, "Remove angle-bracket tags from the description.")
            bare = strip_quoted(desc)
            if FIRST_PERSON.search(bare) or SECOND_PERSON.search(bare):
                self.add("D2", "description", "description_not_third_person", BLOCK,
                         "SKILL.md:description", desc,
                         'Write in third person. "Reviews X", not "I can help you review X".')
            if not re.search(r"\b(use|trigger|when|whenever|before|after)\b", desc, re.I):
                self.add("D3", "description", "description_missing_when", BLOCK,
                         "SKILL.md:description", desc,
                         "State when to use it, not only what it does.")

        for key in ("name", "description"):
            if "<" in fm.get(key, "") and key == "name":
                self.add("N1", "convention", "name_has_xml", BLOCK, "SKILL.md:name", fm[key],
                         "Remove angle-bracket tags from the name.")
        return fm, body, offset

    # ---------- body ----------

    def check_body(self, body: str, offset: int):
        lines = body.splitlines()
        if len(lines) > MAX_BODY_LINES:
            self.add("S1", "structure", "body_too_long", MAJOR, f"SKILL.md:{offset + len(lines)}",
                     f"{len(lines)} lines", "Push reference material into files under references/.")

        for i, line in enumerate(lines, start=offset + 1):
            if WINDOWS_PATH.search(line):
                self.add("I4", "integrity", "windows_path", MAJOR, f"SKILL.md:{i}", line,
                         "Use forward slashes; backslash paths break on Unix.")
            if TIME_SENSITIVE.search(line):
                self.add("C4", "content", "time_sensitive", MAJOR, f"SKILL.md:{i}", line,
                         'Move to an "Old patterns" section or state the rule without the date.')
            if SPEC_SMELL.search(line):
                self.add("K2", "cost", "spec_smell_verified_date", MAJOR, f"SKILL.md:{i}", line,
                         "A verified-on date means this is a spec. Make it a script.")
            if HARDCODED_ID.search(line) and "```" not in line:
                self.add("K2", "cost", "spec_smell_hardcoded_id", MINOR, f"SKILL.md:{i}", line,
                         "Hardcoded IDs go stale. Look them up, or move to a script.")
            if MENU.search(line):
                self.add("C12", "content", "menu_not_default", MAJOR, f"SKILL.md:{i}", line,
                         "Give one default plus a named condition for the alternative.")

    # ---------- code fences ----------

    def check_fences(self, text: str, filename: str, offset: int = 0):
        lang, start, buf = None, 0, []
        for i, line in enumerate(text.splitlines(), start=offset + 1):
            m = FENCE.match(line)
            if m and lang is None:
                lang, start, buf = (m.group(1) or "text").lower(), i, []
                continue
            if line.strip() == "```" and lang is not None:
                self.scan_fence(lang, buf, filename, start)
                lang = None
                continue
            if lang is not None:
                buf.append((i, line))

    def scan_security(self, buf, filename, shellish: bool):
        """X4, X1 and X3 over numbered lines, from a fence or from a bundled script."""
        for ln, line in buf:
            if ALLOW_LINE.search(line):
                continue
            if INSECURE.search(line):
                self.add("X4", "security", "tls_verification_disabled", BLOCK,
                         f"{filename}:{ln}", line, "Never disable certificate verification.")
            if leaks_credential(line):
                self.add("X1", "security", "credential_in_output", BLOCK,
                         f"{filename}:{ln}", line,
                         'Keep credentials in the command environment: eval "$(auth --machine <scope>)" && <cmd>')
            if shellish and unquoted_vars(line) and not line.lstrip().startswith("#"):
                self.add("X3", "security", "unquoted_shell_variable", BLOCK,
                         f"{filename}:{ln}", line, 'Quote it: "$VAR". Unquoted values word-split.')

    def scan_fence(self, lang, buf, filename, start):
        shellish = lang in {"bash", "sh", "shell", "zsh", "console", "text", ""}
        self.scan_security(buf, filename, shellish)
        for ln, line in buf:
            m = VOODOO.match(line)
            if m and not any(c.strip().startswith(("#", "//")) for _, c in buf[: buf.index((ln, line))][-1:]):
                self.add("K7", "cost", "voodoo_constant", MAJOR, f"{filename}:{ln}", line,
                         f"Say why {m.group(2)}. If you cannot, the model cannot either.")

    # ---------- references ----------

    def reference_files(self) -> set[Path]:
        """Bundled references: markdown under references/, or beside SKILL.md.

        `rglob("*.md")` also swept eval fixtures, so a markdown file that an eval case feeds to
        the skill was reported as an orphan reference with a nested link — valid test data, a
        major finding.
        """
        found = set(self.root.glob("references/**/*.md")) | set(self.root.glob("*.md"))
        return {
            p for p in found
            if p.name != "SKILL.md" and ".git" not in p.parts and not is_test_data(p.relative_to(self.root))
        }

    def check_references(self, body: str):
        top = mentioned_md(body)
        ref_files = sorted(self.reference_files())
        for path in ref_files:
            rel = path.relative_to(self.root).as_posix()
            text = read(path)
            n = len(text.splitlines())

            if LAZY_FILENAMES.match(path.name):
                self.add("N4", "convention", "undescriptive_filename", MINOR, rel, path.name,
                         "Name the file after its content, e.g. form_validation_rules.md.")

            if path.name not in top:
                self.add("S2", "structure", "orphan_reference", MAJOR, rel, path.name,
                         "Link it directly from SKILL.md, or delete it.")

            # Same widened `top`: a nested link is only nested if SKILL.md cites it nowhere,
            # in any form. The source side stays link-only — a reference naming CLAUDE.md in
            # prose is not declaring a second level of references.
            for nested in MD_LINK.findall(text):
                if Path(nested).name not in top:
                    self.add("S2", "structure", "nested_reference", MAJOR, rel, nested,
                             "Keep references one level deep; nested files get partially read.")

            if n > TOC_REQUIRED_OVER:
                head = "\n".join(text.splitlines()[:30]).lower()
                if "contents" not in head and "table of contents" not in head:
                    self.add("S3", "structure", "missing_toc", MINOR, rel, f"{n} lines",
                             "Add a Contents list so partial reads still show the full scope.")

            self.check_fences(text, rel)

    # ---------- tests ----------

    def check_tests(self):
        evals = list(self.root.glob("evals/*.json")) + list(self.root.glob("evals.json"))
        count = 0
        for p in evals:
            try:
                data = json.loads(read(p))
            except json.JSONDecodeError:
                continue
            items = data.get("evals", data) if isinstance(data, dict) else data
            if isinstance(items, list):
                count += len(items)
        if count < 3:
            self.add("T1", "tests", "insufficient_evals", BLOCK, "evals/", f"{count} found",
                     "Write at least three evals. Build them before the prose, not after.")

        scripts = [p for p in self.root.glob("scripts/*") if p.suffix in {".py", ".sh", ".js", ".ts"}]
        if scripts:
            has_tests = any(
                "test" in p.name.lower() for p in self.root.rglob("*")
                if p.is_file() and p.suffix in {".py", ".sh", ".js", ".ts"}
            )
            if not has_tests:
                self.add("T8", "tests", "untested_script", MAJOR, "scripts/",
                         ", ".join(p.name for p in scripts),
                         "A script that runs cleanly and returns the wrong answer is the worst failure mode.")

    # ---------- scripts ----------

    def check_scripts(self):
        """Scan the code the skill actually ships.

        Checking only that a test file exists (T8) let a bundled script disable TLS or write a
        token to a file with nothing reported, while the judgment pass was told the deterministic
        security checks were already settled. Test files and eval fixtures are skipped: their
        contents are deliberately bad input, so a finding there describes the fixture rather than
        anything the skill does.
        """
        for path in sorted(self.root.rglob("*")):
            if not path.is_file() or path.suffix not in SCRIPT_SUFFIXES:
                continue
            if is_test_data(path.relative_to(self.root)):
                continue
            rel = path.relative_to(self.root).as_posix()
            lines = list(enumerate(read(path).splitlines(), start=1))
            self.scan_security(lines, rel, shellish=path.suffix == ".sh")

    # ---------- tools ----------

    def check_tools(self, fm: dict, body: str):
        allowed = fm.get("allowed-tools") or fm.get("allowed_tools")
        if allowed:
            declared = {t.strip() for t in re.split(r"[,\s]+", allowed) if t.strip()}
            used = set(re.findall(r"\b(Bash|Read|Write|Edit|Glob|Grep|WebFetch|WebSearch|Agent|Task)\b", body))
            for tool in sorted(used - declared):
                self.add("I1", "integrity", "tool_not_allowed", BLOCK, "SKILL.md", tool,
                         f"`{tool}` is used but missing from allowed-tools.")
        for raw in set(re.findall(r"\bmcp__[a-zA-Z0-9_]+", body)):
            self.add("I2", "integrity", "mcp_tool_unqualified", MINOR, "SKILL.md", raw,
                     "Reference MCP tools as ServerName:tool_name so they resolve.")

    def run(self) -> list[Finding]:
        if not self.skill_md.exists():
            self.add("S0", "structure", "no_skill_md", BLOCK, str(self.root), "SKILL.md missing",
                     "Every skill needs a SKILL.md at its root.")
            return self.findings
        raw = read(self.skill_md)
        fm, body, offset = self.check_frontmatter(raw)
        self.check_body(body, offset)
        self.check_fences(body, "SKILL.md", offset)
        self.check_references(body)
        self.check_tests()
        self.check_scripts()
        self.check_tools(fm, body)
        return self.findings


def parse_frontmatter(block: str) -> dict[str, str]:
    """Flat key: value parse. Handles folded values and quoted strings."""
    out, key, buf = {}, None, []
    for line in block.splitlines():
        m = re.match(r"^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$", line)
        if m:
            if key:
                out[key] = " ".join(buf).strip()
            key, buf = m.group(1), [m.group(2)]
        elif key and line.strip():
            buf.append(line.strip())
    if key:
        out[key] = " ".join(buf).strip()
    return {k: v.strip().strip("\"'") for k, v in out.items()}


def is_test_data(rel: Path) -> bool:
    """Test files and eval fixtures. A finding in either describes the fixture, not the skill."""
    if {"evals", "tests", "__tests__", "fixtures", "__pycache__"} & set(rel.parts):
        return True
    return bool(TEST_FILENAME.search(rel.stem))


def is_variable(name: str, sigil: bool) -> bool:
    """Does this word name a variable, or is it prose? A credential is always a variable, and
    only a variable: `$TOKEN`, `api_key`, `apiKey`, `GITHUB_TOKEN`. A bare lowercase word in a
    sentence is not, which is what separates a real leak from `echo "<path>"`."""
    return bool(sigil or "_" in name or name.isupper() or re.search(r"[a-z][A-Z]", name))


def is_secret_name(name: str) -> bool:
    parts = [p.lower() for p in re.split(r"_|(?<=[a-z0-9])(?=[A-Z])", name) if p]
    if any(p in SECRET_PARTS for p in parts):
        return True
    return any(pair in SECRET_PAIRS for pair in zip(parts, parts[1:]))


def secret_names(text: str) -> list[str]:
    """Credential-shaped variable names in `text`.

    The old form matched SECRET_WORD as a bare substring, so `PAT` inside "path" and "pattern"
    turned every `echo "<path>"` into a blocking X1. Splitting a candidate into its parts first
    means a secret has to be named, not merely spelled by accident.
    """
    out = []
    for m in NAME_REF.finditer(text):
        name = m.group(2)
        if is_variable(name, m.group(1) is not None) and is_secret_name(name):
            out.append(name)
    return out


def leaks_credential(line: str) -> bool:
    """Printed to stdout, or redirected somewhere durable."""
    if PRINTER.search(line) and secret_names(line):
        return True
    target = WRITE_TARGET.search(line)
    return bool(target and secret_names(line[: target.start()]))


def unquoted_vars(line: str) -> list[str]:
    """Variable references that sit outside every quoted span on this line.

    Quote state is a stack, not a flag: `$( )` restarts quoting, so both `"` in
    `"$(dirname "$F")"` open a string rather than the second one closing the first. Word
    splitting applies inside a substitution the same way it does at the top level, which is why
    the substitution is a fresh context and not part of the string around it. Single quotes do
    not interpolate at all.
    """
    found: list[str] = []
    stack: list[str] = []
    i = 0
    while i < len(line):
        ch = line[i]
        top = stack[-1] if stack else None
        if top == "'":
            if ch == "'":
                stack.pop()
            i += 1
            continue
        if ch == "\\":
            i += 2
            continue
        if top == '"' and ch == '"':
            stack.pop()
            i += 1
            continue
        if line.startswith("$(", i):
            stack.append("(")
            i += 2
            continue
        if top == "(" and ch == ")":
            stack.pop()
            i += 1
            continue
        if ch in "\"'":
            stack.append(ch)
            i += 1
            continue
        if top != '"':
            m = VAR_REF.match(line, i)
            if m:
                found.append(m.group(0))
                i = m.end()
                continue
        i += 1
    return found


def strip_quoted(text: str) -> str:
    return QUOTED_SPAN.sub(" ", text)


def mentioned_md(text: str) -> set[str]:
    """Basenames of every .md file this text cites — as a link, in backticks, or bare."""
    names = {Path(p).name for p in MD_LINK.findall(text)}
    names |= {Path(raw).name for raw in MD_MENTION.findall(URL.sub(" ", text))}
    return names


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def squash(s: str, limit: int = 160) -> str:
    s = " ".join(str(s).split())
    return s if len(s) <= limit else s[: limit - 1] + "…"


ICON = {BLOCK: "BLOCK", MAJOR: "MAJOR", MINOR: "minor"}


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    as_json = "--json" in sys.argv[1:]
    if not args:
        print(__doc__)
        return 2

    root = Path(args[0]).expanduser().resolve()
    findings = Checker(root).run()
    order = {BLOCK: 0, MAJOR: 1, MINOR: 2}
    findings.sort(key=lambda f: (order[f.severity], f.id))

    if as_json:
        print(json.dumps({"skill": root.name, "path": str(root),
                          "findings": [asdict(f) for f in findings]}, indent=2))
    else:
        counts = {s: sum(1 for f in findings if f.severity == s) for s in (BLOCK, MAJOR, MINOR)}
        print(f"\n{root.name} — deterministic pass")
        print(f"{counts[BLOCK]} blockers, {counts[MAJOR]} major, {counts[MINOR]} minor\n")
        for f in findings:
            print(f"  [{ICON[f.severity]}] {f.id} {f.finding_type}  ({f.location})")
            print(f"          {f.evidence}")
            print(f"          -> {f.fix}\n")
        if not findings:
            print("  Clean. Every judgment check still has to run.\n")

    return 1 if any(f.severity == BLOCK for f in findings) else 0


if __name__ == "__main__":
    sys.exit(main())
