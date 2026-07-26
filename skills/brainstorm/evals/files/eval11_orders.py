from dataclasses import dataclass
from enum import Enum

class OrderStatus(str, Enum):
    PENDING = "pending"
    PAID = "paid"
    SHIPPED = "shipped"

@dataclass
class Order:
    id: str
    amount_cents: int
    status: OrderStatus = OrderStatus.PENDING

def mark_paid(order: Order) -> Order:
    if order.status is not OrderStatus.PENDING:
        raise ValueError(f"cannot mark {order.status} order paid")
    return Order(order.id, order.amount_cents, OrderStatus.PAID)
