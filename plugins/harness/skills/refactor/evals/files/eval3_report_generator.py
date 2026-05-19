import json
import os
from datetime import datetime
from typing import Any


def generate_report(report_type: str, data: list[dict], output_dir: str,
                    include_summary: bool = True) -> str:
    filtered = []
    for item in data:
        if item.get("active"):
            filtered.append(item)

    totals = {}
    for item in filtered:
        cat = item.get("category", "uncategorized")
        if cat not in totals:
            totals[cat] = 0
        totals[cat] += item.get("amount", 0)

    lines = []
    lines.append(f"# {report_type} Report")
    lines.append(f"Generated: {datetime.now().isoformat()}")
    lines.append("")

    if include_summary:
        lines.append("## Summary")
        lines.append(f"Total items: {len(filtered)}")
        lines.append(f"Categories: {len(totals)}")
        grand_total = 0
        for cat, amount in totals.items():
            grand_total += amount
        lines.append(f"Grand total: ${grand_total:.2f}")
        lines.append("")

    lines.append("## Details")
    for cat, amount in sorted(totals.items()):
        pct = (amount / grand_total * 100) if grand_total > 0 else 0
        lines.append(f"- {cat}: ${amount:.2f} ({pct:.1f}%)")

    lines.append("")
    lines.append("## Items")
    for item in filtered:
        lines.append(f"- [{item.get('category', '?')}] {item.get('name', 'Unknown')}: "
                      f"${item.get('amount', 0):.2f}")

    content = "\n".join(lines)

    os.makedirs(output_dir, exist_ok=True)
    filename = f"{report_type.lower().replace(' ', '_')}_{datetime.now().strftime('%Y%m%d')}.md"
    filepath = os.path.join(output_dir, filename)
    with open(filepath, "w") as f:
        f.write(content)

    metadata = {
        "report_type": report_type,
        "item_count": len(filtered),
        "categories": list(totals.keys()),
        "grand_total": grand_total,
        "filepath": filepath,
    }
    meta_path = os.path.join(output_dir, filename.replace(".md", "_meta.json"))
    with open(meta_path, "w") as f:
        json.dump(metadata, f, indent=2)

    return filepath


def load_data_from_csv(path: str) -> list[dict[str, Any]]:
    result = []
    with open(path) as f:
        header = f.readline().strip().split(",")
        for line in f:
            vals = line.strip().split(",")
            row = {}
            for i in range(len(header)):
                row[header[i]] = vals[i] if i < len(vals) else ""
            result.append(row)
    return result


def format_currency(amount: float) -> str:
    return f"${amount:,.2f}"
