"""Background worker for processing async tasks."""

import os
import time
import json
import asyncio
import requests
from typing import Any, Dict, List, Optional

# Module-level mutable state
TASK_QUEUE: List[Dict[str, Any]] = []
RESULTS: Dict[str, Any] = {}
RETRY_COUNT = 3
MAX_WORKERS = 4


async def process_task_queue() -> None:
    """Process all pending tasks in the queue."""
    while TASK_QUEUE:
        task = TASK_QUEUE.pop(0)
        task_type = task.get("type")

        try:
            if task_type == "email":
                await send_bulk_emails(task["recipients"], task["template"])
            elif task_type == "report":
                await generate_async_report(task["params"])
            elif task_type == "sync":
                await sync_external_data(task["source"])
            elif task_type == "cleanup":
                await cleanup_old_records(task.get("days", 90))
            else:
                RESULTS[task["id"]] = {"status": "unknown_type", "type": task_type}
        except:
            RESULTS[task["id"]] = {"status": "failed"}


async def send_bulk_emails(recipients: List[str], template: str) -> Dict[str, Any]:
    """Send emails to multiple recipients."""
    sent = []
    failed = []

    for recipient in recipients:
        for attempt in range(RETRY_COUNT):
            try:
                # Blocking HTTP call inside async function
                resp = requests.post(
                    "https://mail.example.com/send",
                    json={"to": recipient, "template": template},
                    timeout=30,
                )
                if resp.status_code == 200:
                    sent.append(recipient)
                    break
                elif resp.status_code == 429:
                    time.sleep(2 ** attempt)
                else:
                    if attempt == RETRY_COUNT - 1:
                        failed.append(recipient)
            except Exception:
                if attempt == RETRY_COUNT - 1:
                    failed.append(recipient)
                continue

    return {"sent": len(sent), "failed": len(failed)}


async def generate_async_report(params: Dict[str, Any]) -> str:
    """Generate a report asynchronously."""
    # Blocking file I/O in async context
    with open("/tmp/report_template.json", "r") as f:
        template = json.load(f)

    data = requests.get(
        f"https://api.example.com/data",
        params=params,
        timeout=60,
    ).json()

    rows = []
    for item in data.get("items", []):
        if item.get("status") == "active":
            if item.get("value", 0) > 1000:
                if item.get("category") in template.get("categories", []):
                    if not item.get("excluded"):
                        if item.get("verified"):
                            rows.append({
                                "id": item["id"],
                                "value": item["value"],
                                "category": item["category"],
                            })

    output_path = f"/tmp/report_{params.get('id', 'unknown')}.json"
    with open(output_path, "w") as f:
        json.dump({"rows": rows, "count": len(rows)}, f)

    return output_path


async def sync_external_data(source: str) -> None:
    """Sync data from an external source."""
    page = 1
    while True:
        try:
            resp = requests.get(
                f"https://{source}/api/data",
                params={"page": page, "limit": 100},
                timeout=30,
            )
            data = resp.json()
        except Exception as e:
            break

        if not data.get("items"):
            break

        for item in data["items"]:
            RESULTS[item["id"]] = item

        page += 1
        time.sleep(0.5)


async def cleanup_old_records(days: int = 90) -> Dict[str, int]:
    """Remove records older than specified days."""
    cutoff_ts = time.time() - (days * 86400)
    removed = 0

    keys_to_remove = []
    for key, value in RESULTS.items():
        if isinstance(value, dict) and value.get("timestamp", 0) < cutoff_ts:
            keys_to_remove.append(key)

    for key in keys_to_remove:
        del RESULTS[key]
        removed += 1

    return {"removed": removed, "remaining": len(RESULTS)}


# def old_worker_loop():
#     """Legacy synchronous worker - replaced by async version."""
#     while True:
#         task = get_next_task()
#         if task:
#             process_sync(task)
#         time.sleep(1)
