"""Data models for the application."""

from typing import Optional
from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class User:
    id: str
    name: str
    email: str
    phone: Optional[str] = None
    default_card_token: Optional[str] = None
    created_at: datetime = field(default_factory=datetime.now)

    class query:
        @staticmethod
        def get(user_id: str) -> "User":
            ...

        @staticmethod
        def filter_by(**kwargs):
            ...

    def save(self):
        ...


@dataclass
class Order:
    id: str
    user_id: str
    items_json: Optional[str] = None
    total: float = 0.0
    status: str = "pending"
    payment_id: Optional[str] = None
    created_at: datetime = field(default_factory=datetime.now)

    class query:
        @staticmethod
        def filter_by(**kwargs):
            ...

    @classmethod
    def create(cls, **kwargs) -> "Order":
        ...

    def save(self):
        ...


@dataclass
class Payment:
    id: str
    order_id: str
    amount: float
    status: str
    provider_id: Optional[str] = None
