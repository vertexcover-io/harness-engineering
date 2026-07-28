"""Tests for a shopping cart discount engine. These tests need review."""
import pytest
from unittest.mock import MagicMock, patch
from dataclasses import dataclass
from typing import Optional


# --- The code under test ---

@dataclass
class CartItem:
    product_id: str
    name: str
    price: float
    quantity: int


class DiscountEngine:
    def __init__(self, promo_service, loyalty_service):
        self.promo_service = promo_service
        self.loyalty_service = loyalty_service

    def apply_discounts(self, user_id: str, items: list[CartItem], promo_code: Optional[str] = None) -> dict:
        subtotal = sum(item.price * item.quantity for item in items)

        loyalty_discount = 0.0
        tier = self.loyalty_service.get_tier(user_id)
        if tier == "gold":
            loyalty_discount = subtotal * 0.10
        elif tier == "silver":
            loyalty_discount = subtotal * 0.05

        promo_discount = 0.0
        if promo_code:
            promo = self.promo_service.validate(promo_code)
            if promo and promo["active"]:
                if promo["type"] == "percent":
                    promo_discount = subtotal * (promo["value"] / 100)
                elif promo["type"] == "fixed":
                    promo_discount = min(promo["value"], subtotal)

        # Only apply the larger discount, not both
        best_discount = max(loyalty_discount, promo_discount)
        final_total = max(subtotal - best_discount, 0)

        return {
            "subtotal": subtotal,
            "discount_applied": round(best_discount, 2),
            "discount_source": "loyalty" if loyalty_discount >= promo_discount else "promo",
            "final_total": round(final_total, 2),
        }


# --- The tests (these have problems) ---

# Shared state across all tests
shared_items = [
    CartItem("prod-1", "Widget", 25.00, 2),
    CartItem("prod-2", "Gadget", 50.00, 1),
]


class TestDiscountEngine:
    def setup_method(self):
        self.mock_promo = MagicMock()
        self.mock_loyalty = MagicMock()
        self.engine = DiscountEngine(self.mock_promo, self.mock_loyalty)

    # --- Test for apply_discounts internals ---

    def test_apply_discounts_calls_get_tier(self):
        self.mock_loyalty.get_tier.return_value = "bronze"
        self.mock_promo.validate.return_value = None
        self.engine.apply_discounts("user-1", shared_items)
        self.mock_loyalty.get_tier.assert_called_once_with("user-1")

    def test_apply_discounts_calls_validate_when_promo_code_given(self):
        self.mock_loyalty.get_tier.return_value = "bronze"
        self.mock_promo.validate.return_value = {"active": True, "type": "percent", "value": 20}
        self.engine.apply_discounts("user-1", shared_items, promo_code="SAVE20")
        self.mock_promo.validate.assert_called_once_with("SAVE20")

    def test_apply_discounts_does_not_call_validate_without_promo(self):
        self.mock_loyalty.get_tier.return_value = "bronze"
        self.engine.apply_discounts("user-1", shared_items)
        self.mock_promo.validate.assert_not_called()

    # --- Test that mirrors the if-else structure ---

    def test_gold_tier_path(self):
        self.mock_loyalty.get_tier.return_value = "gold"
        self.mock_promo.validate.return_value = None
        result = self.engine.apply_discounts("user-1", shared_items)
        # Only checks discount_source, not the actual amounts
        assert result["discount_source"] == "loyalty"

    def test_silver_tier_path(self):
        self.mock_loyalty.get_tier.return_value = "silver"
        self.mock_promo.validate.return_value = None
        result = self.engine.apply_discounts("user-1", shared_items)
        assert result["discount_source"] == "loyalty"

    def test_percent_promo_path(self):
        self.mock_loyalty.get_tier.return_value = "bronze"
        self.mock_promo.validate.return_value = {"active": True, "type": "percent", "value": 10}
        result = self.engine.apply_discounts("user-1", shared_items)
        assert result["discount_source"] == "promo"

    def test_fixed_promo_path(self):
        self.mock_loyalty.get_tier.return_value = "bronze"
        self.mock_promo.validate.return_value = {"active": True, "type": "fixed", "value": 15}
        result = self.engine.apply_discounts("user-1", shared_items)
        assert result["discount_source"] == "promo"

    # --- Mutation test: someone modifies shared_items, breaks other tests ---

    def test_empty_cart(self):
        """This test accidentally clears the shared list."""
        self.mock_loyalty.get_tier.return_value = "bronze"
        shared_items.clear()  # BUG: mutates shared state
        result = self.engine.apply_discounts("user-1", shared_items)
        assert result["final_total"] == 0
