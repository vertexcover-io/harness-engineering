import { db } from "./database";

interface Order {
  id: string;
  items: { productId: string; qty: number; price: number }[];
  status: string;
  discount: number;
  createdAt: Date;
}

// Calculate the total for an order after applying discount
function calculateTotal(order: any): number {
  let total = 0;
  for (let i = 0; i < order.items.length; i++) {
    total += order.items[i].qty * order.items[i].price;
  }
  if (order.discount) {
    total = total - total * (order.discount / 100);
  }
  return Math.round(total * 100) / 100;
}

// Apply a coupon to the order
function applyCoupon(order: Order, code: string, percentage: number) {
  order.discount = percentage;
  order.items.forEach((item) => {
    (item as any).discountApplied = true;
  });
  return order;
}

async function createOrder(
  userId: string,
  items: { productId: string; qty: number; price: number }[],
  couponCode: string,
  shippingAddress: string,
  billingAddress: string,
  notes: string,
  giftWrap: boolean
) {
  const order: Order = {
    id: crypto.randomUUID(),
    items: items,
    status: "pending",
    discount: 0,
    createdAt: new Date(),
  };

  // validate items
  if (items.length === 0) {
    throw new Error("No items");
  }
  for (const item of items) {
    if (item.qty <= 0) {
      throw new Error("Invalid quantity");
    }
    if (item.price < 0) {
      throw new Error("Invalid price");
    }
  }

  if (couponCode) {
    try {
      const coupon = await db.findCoupon(couponCode);
      applyCoupon(order, couponCode, coupon.percentage);
    } catch (e) {
      // @ts-ignore
      console.log("Coupon error: " + e.message);
    }
  }

  const total = calculateTotal(order);

  if (total > 10000) {
    if (userId) {
      const user = await db.findUser(userId);
      if (user) {
        if (user.verified) {
          await db.saveOrder(order);
        } else {
          throw new Error("User not verified for large orders");
        }
      } else {
        throw new Error("User not found");
      }
    } else {
      throw new Error("User required for large orders");
    }
  } else {
    await db.saveOrder(order);
  }

  return { success: true, orderId: order.id, total };
}

export function processRefund(order: Order): any {
  if (order.status !== "delivered") {
    return { error: "Cannot refund undelivered order" };
  }
  order.status = "refunded";
  const refundAmount = calculateTotal(order);
  return { success: true, amount: refundAmount };
}
