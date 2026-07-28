from dataclasses import dataclass
from enum import Enum
from typing import Optional


class StockStatus(Enum):
    IN_STOCK = "in_stock"
    LOW_STOCK = "low_stock"
    OUT_OF_STOCK = "out_of_stock"
    DISCONTINUED = "discontinued"


@dataclass
class Product:
    sku: str
    name: str
    quantity: int
    reorder_threshold: int
    max_quantity: int
    price_cents: int
    is_discontinued: bool = False


class InsufficientStockError(Exception):
    def __init__(self, sku: str, requested: int, available: int):
        self.sku = sku
        self.requested = requested
        self.available = available
        super().__init__(f"Cannot reserve {requested} of {sku}: only {available} available")


class InventoryManager:
    def __init__(self, storage):
        self.storage = storage

    def get_status(self, sku: str) -> StockStatus:
        product = self.storage.get_product(sku)
        if product is None:
            raise KeyError(f"Unknown SKU: {sku}")
        if product.is_discontinued:
            return StockStatus.DISCONTINUED
        if product.quantity == 0:
            return StockStatus.OUT_OF_STOCK
        if product.quantity <= product.reorder_threshold:
            return StockStatus.LOW_STOCK
        return StockStatus.IN_STOCK

    def reserve(self, sku: str, quantity: int) -> dict:
        if quantity <= 0:
            raise ValueError("Quantity must be positive")

        product = self.storage.get_product(sku)
        if product is None:
            raise KeyError(f"Unknown SKU: {sku}")

        if product.is_discontinued:
            raise ValueError(f"Cannot reserve discontinued product: {sku}")

        if product.quantity < quantity:
            raise InsufficientStockError(sku, quantity, product.quantity)

        new_quantity = product.quantity - quantity
        self.storage.update_quantity(sku, new_quantity)

        reorder_needed = new_quantity <= product.reorder_threshold and not product.is_discontinued
        return {
            "sku": sku,
            "reserved": quantity,
            "remaining": new_quantity,
            "reorder_needed": reorder_needed,
        }

    def restock(self, sku: str, quantity: int) -> dict:
        if quantity <= 0:
            raise ValueError("Quantity must be positive")

        product = self.storage.get_product(sku)
        if product is None:
            raise KeyError(f"Unknown SKU: {sku}")

        if product.is_discontinued:
            raise ValueError(f"Cannot restock discontinued product: {sku}")

        new_quantity = min(product.quantity + quantity, product.max_quantity)
        capped = (product.quantity + quantity) > product.max_quantity
        self.storage.update_quantity(sku, new_quantity)

        return {
            "sku": sku,
            "added": new_quantity - product.quantity,
            "new_quantity": new_quantity,
            "capped_at_max": capped,
        }

    def bulk_status(self, skus: list[str]) -> dict[str, StockStatus]:
        results = {}
        for sku in skus:
            try:
                results[sku] = self.get_status(sku)
            except KeyError:
                results[sku] = None
        return results

    def discontinue(self, sku: str) -> dict:
        product = self.storage.get_product(sku)
        if product is None:
            raise KeyError(f"Unknown SKU: {sku}")
        self.storage.mark_discontinued(sku)
        return {"sku": sku, "status": "discontinued", "remaining_stock": product.quantity}
