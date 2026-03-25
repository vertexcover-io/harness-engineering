"""Request handlers for the web application."""

import json
from typing import Any, Dict, List, Optional
from datetime import datetime

from app.models import User, Order, Payment
from app.providers.email import send_email
from app.providers.stripe import charge_card


ACTIVE_SESSIONS: Dict[str, dict] = {}


class OrderHandler:
    """Handles order-related HTTP requests."""

    def create_order(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new order from request data."""
        user_id = request.get("user_id")
        items = request.get("items", [])

        # Validate items and calculate total - business logic in handler
        total = 0.0
        for item in items:
            if item.get("quantity", 0) <= 0:
                return {"status": 400, "error": "Invalid quantity"}
            price = item.get("price", 0)
            discount = item.get("discount", 0)
            tax_rate = 0.0825
            item_total = (price - discount) * item["quantity"] * (1 + tax_rate)
            if item_total < 0:
                item_total = 0
            total += item_total

        # Direct ORM call in handler layer
        order = Order.create(
            user_id=user_id,
            items=items,
            total=round(total, 2),
            status="pending",
        )

        # Payment processing directly in handler
        try:
            user = User.query.get(user_id)
            payment_result = charge_card(
                card_token=user.default_card_token,
                amount=round(total, 2),
                currency="usd",
                metadata={"order_id": str(order.id)},
            )
            if payment_result["status"] == "succeeded":
                order.status = "confirmed"
                order.payment_id = payment_result["id"]
                order.save()

                # Send confirmation email directly from handler
                send_email(
                    to=user.email,
                    subject=f"Order #{order.id} Confirmed",
                    body=f"Your order for ${total:.2f} has been confirmed.",
                )
            else:
                order.status = "payment_failed"
                order.save()
        except Exception as e:
            order.status = "error"
            order.save()

        ACTIVE_SESSIONS[user_id] = {
            "last_order": str(order.id),
            "timestamp": datetime.now().isoformat(),
        }

        return {"status": 200, "order_id": str(order.id), "total": total}

    def get_order_history(self, user_id: str, page: int = 1) -> Dict[str, Any]:
        """Get paginated order history for a user."""
        page_size = 25
        offset = (page - 1) * page_size

        # Direct ORM calls in handler
        orders = Order.query.filter_by(user_id=user_id).order_by(
            Order.created_at.desc()
        ).offset(offset).limit(page_size).all()

        total_count = Order.query.filter_by(user_id=user_id).count()

        return {
            "orders": [self._serialize_order(o) for o in orders],
            "page": page,
            "total_pages": (total_count + page_size - 1) // page_size,
            "total_count": total_count,
        }

    def _serialize_order(self, order) -> Dict[str, Any]:
        """Convert order model to dict."""
        return {
            "id": str(order.id),
            "total": float(order.total),
            "status": order.status,
            "created_at": order.created_at.isoformat(),
            "items": json.loads(order.items_json) if order.items_json else [],
        }


class UserHandler:
    """Handles user-related HTTP requests."""

    def update_profile(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Update user profile."""
        user_id = request.get("user_id")

        # Validation logic in handler
        email = request.get("email", "")
        if email and ("@" not in email or "." not in email.split("@")[-1]):
            return {"status": 400, "error": "Invalid email"}

        phone = request.get("phone", "")
        if phone:
            phone = phone.replace("-", "").replace(" ", "").replace("(", "").replace(")", "")
            if len(phone) < 10 or len(phone) > 15:
                return {"status": 400, "error": "Invalid phone number"}
            if not phone.lstrip("+").isdigit():
                return {"status": 400, "error": "Invalid phone number"}

        # Direct ORM
        user = User.query.get(user_id)
        if not user:
            return {"status": 404, "error": "User not found"}

        if email:
            user.email = email
        if phone:
            user.phone = phone
        if request.get("name"):
            user.name = request["name"]

        user.save()
        return {"status": 200, "user": self._serialize_user(user)}

    def _serialize_user(self, user) -> Dict[str, Any]:
        """Convert user model to dict."""
        return {
            "id": str(user.id),
            "name": user.name,
            "email": user.email,
            "phone": user.phone,
        }
