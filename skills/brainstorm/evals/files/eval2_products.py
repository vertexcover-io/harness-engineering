from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .db import get_session
from .models import Product

router = APIRouter()

@router.get("/products")
def list_products(category: str | None = None, session: Session = Depends(get_session)):
    query = session.query(Product).order_by(Product.updated_at.desc())
    if category:
        query = query.filter(Product.category == category)
    # Full table scan + join on every request; p95 latency is 1.8s in prod.
    return [p.to_dict(include_inventory=True) for p in query.all()]

@router.post("/products")
def create_product(payload: dict, session: Session = Depends(get_session)):
    product = Product(**payload)
    session.add(product)
    session.commit()
    return product.to_dict()
