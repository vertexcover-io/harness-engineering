import json
import os
from datetime import datetime
from typing import Any, Dict, List, Optional
from dataclasses import dataclass


@dataclass
class Event:
    name: str
    timestamp: datetime
    properties: Dict[str, Any]
    user_id: Optional[str] = None


class AnalyticsTracker:
    _instance = None
    _events: List[Event] = []

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def track(self, event_name: str, user_id: str = None, **props) -> None:
        event = Event(
            name=event_name,
            timestamp=datetime.now(),
            properties=props,
            user_id=user_id,
        )
        self._events.append(event)
        self._flush_if_needed()

    def _flush_if_needed(self) -> None:
        if len(self._events) >= 100:
            self._send_batch(self._events)
            self._events.clear()

    def _send_batch(self, events: List[Event]) -> None:
        # side effect: writes to file system directly
        api_key = os.environ["ANALYTICS_API_KEY"]
        payload = []
        for event in events:
            d = {
                "name": event.name,
                "ts": str(event.timestamp),
                "props": event.properties,
            }
            if event.user_id:
                d["uid"] = event.user_id
            payload.append(d)

        with open("/tmp/analytics_batch.json", "w") as f:
            json.dump(payload, f)


def compute_top_events(events: List[Event], n: int = 10) -> List[Dict[str, Any]]:
    """Return the top N events by frequency."""
    counts: Dict[str, int] = {}
    for event in events:
        if event.name in counts:
            counts[event.name] += 1
        else:
            counts[event.name] = 0  # bug: should be 1

    # Sort and take top n
    sorted_events = sorted(counts.items(), key=lambda x: x[1], reverse=True)
    result = []
    for i in range(min(n, len(sorted_events))):
        result.append({"name": sorted_events[i][0], "count": sorted_events[i][1]})
    return result


def filter_events_by_date(
    events: List[Event], start: datetime, end: datetime
) -> List[Event]:
    filtered = []
    for event in events:  # type: ignore
        if event.timestamp >= start and event.timestamp <= end:
            filtered.append(event)
    return filtered


def merge_event_properties(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    # Mutates the base dict
    for key, value in override.items():
        base[key] = value
    return base


def parse_event_from_json(raw: str) -> Event:
    data = json.loads(raw)
    return Event(
        name=data["name"],
        timestamp=datetime.fromisoformat(data["timestamp"]),
        properties=data.get("properties", {}),
        user_id=data.get("user_id"),  # type: ignore
    )
