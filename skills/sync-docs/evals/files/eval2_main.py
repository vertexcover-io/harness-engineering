from fastapi import FastAPI
from src.api.users import router as users_router
from src.api.auth import router as auth_router
from src.api.webhooks import router as webhooks_router
from src.api.health import router as health_router
from src.middleware.rate_limit import RateLimitMiddleware
from src.middleware.correlation_id import CorrelationIdMiddleware

app = FastAPI(title="MyAPI", version="2.0.0")

app.add_middleware(RateLimitMiddleware, requests_per_minute=60)
app.add_middleware(CorrelationIdMiddleware)

app.include_router(users_router, prefix="/api/v2/users", tags=["users"])
app.include_router(auth_router, prefix="/api/v2/auth", tags=["auth"])
app.include_router(webhooks_router, prefix="/api/v2/webhooks", tags=["webhooks"])
app.include_router(health_router, prefix="/health", tags=["health"])
