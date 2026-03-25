import os
import json
import tempfile
from report_generator import generate_report, format_currency


def test_generate_basic_report():
    data = [
        {"name": "Item A", "category": "sales", "amount": 100.0, "active": True},
        {"name": "Item B", "category": "sales", "amount": 200.0, "active": True},
        {"name": "Item C", "category": "marketing", "amount": 50.0, "active": True},
        {"name": "Inactive", "category": "sales", "amount": 999.0, "active": False},
    ]
    with tempfile.TemporaryDirectory() as tmpdir:
        result = generate_report("Monthly", data, tmpdir)
        assert os.path.exists(result)
        content = open(result).read()
        assert "# Monthly Report" in content
        assert "sales" in content
        assert "marketing" in content


def test_generate_report_no_summary():
    data = [{"name": "X", "category": "a", "amount": 10.0, "active": True}]
    with tempfile.TemporaryDirectory() as tmpdir:
        result = generate_report("Test", data, tmpdir, include_summary=False)
        content = open(result).read()
        assert "## Summary" not in content


def test_empty_data():
    with tempfile.TemporaryDirectory() as tmpdir:
        result = generate_report("Empty", [], tmpdir)
        assert os.path.exists(result)


def test_format_currency():
    assert format_currency(1234.5) == "$1,234.50"
    assert format_currency(0) == "$0.00"
