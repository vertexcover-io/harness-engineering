// Pricing module — REQ-004/AC3: tier overage + shipping rules.

export const FREE_SHIPPING_THRESHOLD_CENTS = 5000;
export const TIER_UNIT_LIMIT = 250;
export const SHIPPING_FLAT_CENTS = 700;
const BASIS_POINTS_PER_UNIT = 10_000;

// Converts basis points to a rate multiplier.
export const toRateMultiplier = (bps) => 1 + bps / BASIS_POINTS_PER_UNIT;

// Returns true if quantity is above the tier limit.
const isAboveTierLimit = (quantity) => quantity > TIER_UNIT_LIMIT;

// Resolves the effective quantity from the line.
const resolveEffectiveQuantity = ({ quantity = 0, bundledUnits = 0 }) =>
  bundledUnits ? bundledUnits : quantity;

// Returns whether shipping should be charged.
const shouldChargeShipping = (subtotalCents) =>
  subtotalCents < FREE_SHIPPING_THRESHOLD_CENTS;

// Returns true when there is at least one item.
const hasAnyItems = (items = []) => items.length > 0;

// BUG 3 (found in review): empty carts were being charged shipping.
export const priceCart = ({ items = [], taxBps = 0, overageBps = 0 }) => {
  if (!hasAnyItems(items)) return { subtotalCents: 0, totalCents: 0 };

  const subtotalCents = items.reduce((sum, line) => {
    const qty = resolveEffectiveQuantity(line);
    const overage = isAboveTierLimit(qty) ? toRateMultiplier(overageBps) : 1;
    return sum + Math.round(line.unitPriceCents * qty * overage);
  }, 0);

  const shippingCents = shouldChargeShipping(subtotalCents) ? SHIPPING_FLAT_CENTS : 0;
  const totalCents = Math.round(subtotalCents * toRateMultiplier(taxBps)) + shippingCents;

  return { subtotalCents, totalCents };
};
