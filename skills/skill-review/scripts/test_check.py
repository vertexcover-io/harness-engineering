#!/usr/bin/env python3
"""Tests for check.py.

A checker that runs cleanly and returns the wrong answer is the failure mode the
rubric warns about most (I5), so this asserts on specific finding IDs rather than
on counts. Run: python3 test_check.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from check import Checker  # noqa: E402

BROKEN = """---
name: Helper-Tools
description: I can help you with stuff.
---

# Helper

See [advanced.md](advanced.md) for more.

Use pypdf, or pdfplumber, or PyMuPDF, or pdf2image for this.

Open scripts\\run.py to get started. Verified 2025-11.

```bash
curl -k https://example.com/$ENDPOINT
echo "$API_TOKEN"
TIMEOUT = 47
```
"""

ADVANCED = """# Advanced

See [details.md](details.md) for the actual information.
"""

CLEAN = """---
name: reviewing-invoices
description: Reviews invoice documents and flags mismatched totals. Use when the user asks to check an invoice or reconcile line items.
---

# Reviewing invoices

Read the invoice, then compare each line total against the header total.
"""


def findings_for(files: dict[str, str]) -> dict[str, list]:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for name, text in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        out: dict[str, list] = {}
        for f in Checker(root).run():
            out.setdefault(f.id, []).append(f)
        return out


def test_broken_skill_fires_expected_checks():
    got = findings_for({
        "SKILL.md": BROKEN,
        "advanced.md": ADVANCED,
        "details.md": "# Details\n",
    })
    expected = {
        "N1": "uppercase name",
        "D2": "first/second person description",
        "D3": "description never says when",
        "S2": "nested and orphan references",
        "C12": "menu instead of a default",
        "I4": "windows path",
        "K2": "verified-on date",
        "X3": "unquoted shell variable",
        "X4": "curl -k",
        "X1": "echoed token",
        "K7": "voodoo constant",
        "T1": "fewer than three evals",
    }
    missing = {k: v for k, v in expected.items() if k not in got}
    assert not missing, f"checks did not fire: {missing}"


def test_severity_of_security_findings_is_always_blocker():
    got = findings_for({"SKILL.md": BROKEN, "advanced.md": ADVANCED, "details.md": "# D\n"})
    for cid in ("X1", "X3", "X4"):
        for f in got.get(cid, []):
            assert f.severity == "blocker", f"{cid} must block, got {f.severity}"


def test_clean_skill_has_no_blockers_except_evals():
    got = findings_for({"SKILL.md": CLEAN})
    blockers = {k for k, v in got.items() if any(f.severity == "blocker" for f in v)}
    assert blockers == {"T1"}, f"unexpected blockers on a clean skill: {blockers - {'T1'}}"


def test_external_md_url_is_not_a_nested_reference():
    """A cited URL ending in .md is not a bundled file. Regression: it used to fire S2."""
    skill = CLEAN.replace(
        "Read the invoice",
        "See [the source](https://example.com/a/b/GUIDE.md) first. Read the invoice",
    )
    got = findings_for({"SKILL.md": skill})
    assert "S2" not in got, f"external URL flagged as a local reference: {got.get('S2')}"


def test_quoted_variable_is_not_an_unquoted_shell_variable():
    """`"${p}.mp4"` is correctly quoted. Regression: `\\}?` matched `${p` and fired X3."""
    skill = CLEAN + (
        "\n```bash\n"
        'ffmpeg -v error -i "screenshots/${p}__*.png" "out/${p}.mp4" \\\n'
        '  && echo "ok  ${p}.mp4" || echo "FAILED ${p}"\n'
        "echo 'single ${p} does not interpolate'\n"
        "```\n"
    )
    got = findings_for({"SKILL.md": skill})
    assert "X3" not in got, f"quoted variables flagged: {[f.evidence for f in got['X3']]}"


def test_bare_variable_in_command_position_still_fires():
    for snippet in ("rm -rf $DIR/build", "cp ${SRC} /tmp/out"):
        skill = CLEAN + f"\n```bash\n{snippet}\n```\n"
        got = findings_for({"SKILL.md": skill})
        assert "X3" in got, f"unquoted variable not caught: {snippet}"


def test_quoted_trigger_phrase_is_not_first_person():
    """A trigger list quotes what a user says. Regression: `"can we merge"` fired D2."""
    skill = CLEAN.replace(
        "Use when the user asks",
        'Trigger on "can we merge", "is this ready for your review", "I am done". Use when the user asks',
    )
    got = findings_for({"SKILL.md": skill})
    assert "D2" not in got, f"quoted trigger flagged as first person: {got.get('D2')}"


def test_genuine_first_person_description_still_fires():
    for desc in (
        "I can help you review invoices. Use when an invoice needs checking.",
        "Reviews invoices for our team. Use when an invoice needs checking.",
        "Reviews your invoices. Use when an invoice needs checking.",
    ):
        skill = CLEAN.replace(CLEAN.splitlines()[2], f"description: {desc}")
        got = findings_for({"SKILL.md": skill})
        assert "D2" in got, f"first/second person not caught: {desc}"


def test_backticked_reference_is_not_an_orphan():
    """A skill may cite references as backticked paths rather than markdown links."""
    skill = CLEAN.replace(
        "Read the invoice",
        "Read `references/line-items.md` first, then references/totals.md. Read the invoice",
    )
    got = findings_for({
        "SKILL.md": skill,
        "references/line-items.md": "# Line items\n",
        "references/totals.md": "# Totals\n",
    })
    assert "S2" not in got, f"cited references flagged as orphans: {[f.evidence for f in got['S2']]}"


def test_reference_nothing_mentions_is_still_an_orphan():
    got = findings_for({"SKILL.md": CLEAN, "references/stray.md": "# Stray\n"})
    assert "S2" in got, "a reference nothing cites must still be an orphan"
    assert got["S2"][0].finding_type == "orphan_reference"


def test_missing_skill_md_is_a_blocker():
    got = findings_for({"README.md": "# nope\n"})
    assert "S0" in got and got["S0"][0].severity == "blocker"


def test_every_finding_carries_a_location_and_fix():
    got = findings_for({"SKILL.md": BROKEN, "advanced.md": ADVANCED, "details.md": "# D\n"})
    for group in got.values():
        for f in group:
            assert f.location, f"{f.id} has no location"
            assert f.fix, f"{f.id} has no fix"
            assert f.severity in {"blocker", "major", "minor"}, f.severity


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  pass  {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL  {t.__name__}\n        {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
