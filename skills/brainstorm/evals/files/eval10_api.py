from fastapi import APIRouter, HTTPException, Request
from .eval10_middleware import SlidingWindowRateLimiter

router = APIRouter()
_limiter = SlidingWindowRateLimiter(max_requests=100, window_seconds=60)

@router.get("/search")
def search(request: Request, q: str):
    if not _limiter.allow(request.client.host):
        raise HTTPException(429, "rate limited")
    return {"results": [], "query": q}

@router.post("/webhooks/incoming")
def receive_webhook(request: Request, payload: dict):
    # NOTE: webhook route has no limiter wired in
    return {"accepted": True}
