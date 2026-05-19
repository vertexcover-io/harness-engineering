from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, HttpUrl
from src.services.webhook_service import WebhookService
from src.auth.deps import get_current_user

router = APIRouter()


class WebhookCreate(BaseModel):
    url: HttpUrl
    events: list[str]
    secret: str | None = None


class WebhookResponse(BaseModel):
    id: str
    url: str
    events: list[str]
    active: bool
    created_at: str


@router.post("/", response_model=WebhookResponse)
async def create_webhook(
    payload: WebhookCreate,
    user=Depends(get_current_user),
    service: WebhookService = Depends(),
) -> WebhookResponse:
    """Create a new webhook subscription."""
    return await service.create(user.id, payload)


@router.get("/", response_model=list[WebhookResponse])
async def list_webhooks(
    user=Depends(get_current_user),
    service: WebhookService = Depends(),
) -> list[WebhookResponse]:
    """List all webhook subscriptions for the current user."""
    return await service.list_for_user(user.id)


@router.delete("/{webhook_id}")
async def delete_webhook(
    webhook_id: str,
    user=Depends(get_current_user),
    service: WebhookService = Depends(),
) -> dict:
    """Delete a webhook subscription."""
    await service.delete(user.id, webhook_id)
    return {"status": "deleted"}
