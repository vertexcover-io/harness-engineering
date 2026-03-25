import unittest
from unittest.mock import patch, MagicMock
from order_service import ProcessOrder, getOrdersByUser


class TestProcessOrder(unittest.TestCase):
    def test_process_order_works(self):
        order = {"items": [{"quantity": 2, "price": 30.0}]}
        user = {"id": "u1", "email": "test@test.com"}
        with patch("order_service.smtplib") as mock_smtp:
            with patch("order_service.requests") as mock_requests:
                result = ProcessOrder(order, user)
                mock_smtp.SMTP.assert_called_once()
                mock_requests.post.assert_called_once()
                self.assertIn("order_id", result)

    def test_process_order_with_discount(self):
        order = {"items": [{"quantity": 1, "price": 100.0}]}
        user = {"id": "u2", "email": "gold@test.com", "membership": "gold"}
        with patch("order_service.smtplib") as mock_smtp:
            with patch("order_service.requests") as mock_requests:
                result = ProcessOrder(order, user, apply_discount=True)
                mock_smtp.SMTP.assert_called_once()
                self.assertEqual(result["subtotal"], 85.0)

    def test_no_order_data(self):
        result = ProcessOrder(None, {"id": "u1", "email": "a@b.com"})
        self.assertEqual(result["error"], "No order data provided")

    def test_no_user(self):
        result = ProcessOrder({"items": []}, None)
        self.assertEqual(result["error"], "No user provided")

    def test_get_orders_by_user(self):
        with patch("order_service._orders_cache", {"ORD-1": {"user_id": "u1", "total": 100}}):
            results = getOrdersByUser("u1")
            self.assertEqual(len(results), 1)
