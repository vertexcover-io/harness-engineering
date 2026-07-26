import time
from collections import defaultdict

class SlidingWindowRateLimiter:
    """Per-key sliding-window limiter used by the public API routes."""

    def __init__(self, max_requests: int = 100, window_seconds: int = 60):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._hits: dict[str, list[float]] = defaultdict(list)

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        cutoff = now - self.window_seconds
        hits = [t for t in self._hits[key] if t > cutoff]
        hits.append(now)
        self._hits[key] = hits
        return len(hits) <= self.max_requests
