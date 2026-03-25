import datetime
from typing import Optional


_orders_cache = {}


def ProcessOrder(order_data: dict, user: dict, apply_discount: bool = False,
                 send_notification: bool = True, log_analytics: bool = True,
                 currency: str = "USD") -> dict:
    """Process an order through the pipeline."""
    if order_data:
        if user:
            if order_data.get("items"):
                total = 0
                for item in order_data["items"]:
                    if item.get("quantity") and item.get("price"):
                        if item["quantity"] > 0:
                            if apply_discount:
                                if user.get("membership") == "gold":
                                    total += item["quantity"] * item["price"] * 0.85
                                elif user.get("membership") == "silver":
                                    total += item["quantity"] * item["price"] * 0.90
                                else:
                                    total += item["quantity"] * item["price"] * 0.95
                            else:
                                total += item["quantity"] * item["price"]

                if total > 50:
                    shipping = 0
                else:
                    shipping = 5.99

                tax = total * 0.08

                result = {}
                result["order_id"] = f"ORD-{datetime.datetime.now().timestamp()}"
                result["user_id"] = user["id"]
                result["subtotal"] = total
                result["tax"] = tax
                result["shipping"] = shipping
                result["total"] = total + tax + shipping
                result["status"] = "pending"
                result["created_at"] = datetime.datetime.now().isoformat()

                _orders_cache[result["order_id"]] = result

                if send_notification:
                    import smtplib
                    try:
                        server = smtplib.SMTP("mail.example.com")
                        server.sendmail("orders@example.com", user["email"],
                                        f"Order {result['order_id']} confirmed!")
                        server.quit()
                    except:
                        pass

                if log_analytics:
                    import requests
                    try:
                        requests.post("https://analytics.example.com/events",
                                      json={"event": "order_created", "total": total})
                    except:
                        pass

                return result
            else:
                return {"error": "No items in order"}
        else:
            return {"error": "No user provided"}
    else:
        return {"error": "No order data provided"}


def getOrdersByUser(userId: str) -> list:
    results = []
    for orderId, orderData in _orders_cache.items():
        if orderData["user_id"] == userId:
            results.append(orderData)
    return results


def calcTax(amount, rate=0.08):
    return amount * rate
