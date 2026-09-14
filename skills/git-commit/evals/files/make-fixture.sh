#!/usr/bin/env bash
# Builds the dirty repo an eval runs in: make-fixture.sh EVAL_ID TARGET_DIR
set -euo pipefail

id="$1"
dir="$2"
mkdir -p "$dir"
cd "$dir"
git init -q -b main
git config user.email eval@example.com
git config user.name eval

cat > src.cart.tmp <<'EOF'
export type Item = { sku: string; price: number; qty: number };

export function lineTotal(item: Item): number {
  return item.price * item.qty;
}

export function itemCount(items: Item[]): number {
  return items.reduce((n, i) => n + i.qty, 0);
}

export function isEmpty(items: Item[]): boolean {
  return items.length === 0;
}

export function hasSku(items: Item[], sku: string): boolean {
  return items.some((i) => i.sku === sku);
}

export function cartTotal(items: Item[]): number {
  return items.reduce((sum, i) => sum + lineTotal(i), 0);
}
EOF
mkdir -p src
mv src.cart.tmp src/cart.ts
cat > src/cart.test.ts <<'EOF'
import { test, expect } from "vitest";
import { lineTotal } from "./cart";

test("lineTotal multiplies price by qty", () => {
  expect(lineTotal({ sku: "a", price: 2, qty: 3 })).toBe(6);
});
EOF
printf '{\n  "name": "shop",\n  "dependencies": {}\n}\n' > package.json
printf '{\n  "name": "shop",\n  "lockfileVersion": 3,\n  "packages": {}\n}\n' > package-lock.json
printf '{\n  "compilerOptions": { "strict": false }\n}\n' > tsconfig.json
printf '# Shop\n\nA tiny shoping cart.\n' > README.md
printf 'node_modules/\n.harness/*\n!.harness/knowledge/\n' > .gitignore
git add -A
git commit -qm "feat(cart): add cart model"

add_discount() {
  cat >> src/cart.ts <<'EOF'

export function applyDiscount(total: number, percent: number): number {
  return total - (total * percent) / 100;
}
EOF
  cat >> src/cart.test.ts <<'EOF'

test("applyDiscount takes a percentage off", () => {
  expect(applyDiscount(200, 10)).toBe(180);
});
EOF
  sed -i.bak 's/import { lineTotal } from/import { lineTotal, applyDiscount } from/' src/cart.test.ts
  rm src/cart.test.ts.bak
}

case "$id" in
  1)
    add_discount
    printf '{\n  "compilerOptions": { "strict": true }\n}\n' > tsconfig.json
    printf '# Shop\n\nA tiny shopping cart.\n' > README.md
    git add README.md
    ;;
  2)
    sed -i.bak 's/  return item.price \* item.qty;/  const { price, qty } = item;\n  return price * qty;/' src/cart.ts
    sed -i.bak 's/  return items.reduce((sum, i) => sum + lineTotal(i), 0);/  return Math.round(items.reduce((sum, i) => sum + lineTotal(i), 0) * 100) \/ 100;/' src/cart.ts
    rm src/cart.ts.bak
    cat >> src/cart.test.ts <<'EOF'

test("cartTotal rounds to cents", () => {
  expect(cartTotal([{ sku: "a", price: 0.1, qty: 3 }])).toBe(0.3);
});
EOF
    sed -i.bak 's/import { lineTotal } from/import { lineTotal, cartTotal } from/' src/cart.test.ts
    rm src/cart.test.ts.bak
    ;;
  3)
    sed -i.bak 's/  return items.length === 0;/  return items.every((i) => i.qty === 0);/' src/cart.ts
    rm src/cart.ts.bak
    printf 'remember to ask about coupons\n' > notes.txt
    ;;
  4)
    git checkout -qb feat/checkout
    base="$(git rev-parse HEAD)"
    add_discount
    git add -A && git commit -qm "feat(cart): add percentage discounts"
    printf 'import { cartTotal, Item } from "./cart";\n\nexport function checkout(items: Item[]): number {\n  return cartTotal(items);\n}\n' > src/checkout.ts
    printf 'import { test, expect } from "vitest";\nimport { checkout } from "./checkout";\n\ntest("checkout totals the cart", () => {\n  expect(checkout([{ sku: "a", price: 5, qty: 2 }])).toBe(10);\n});\n' > src/checkout.test.ts
    git add -A && git commit -qm "feat(checkout): add checkout total"
    sed -i.bak 's|  return total - (total \* percent) / 100;|  const capped = Math.min(Math.max(percent, 0), 100);\n  return total - (total * capped) / 100;|' src/cart.ts
    rm src/cart.ts.bak
    git commit -qam "fix: address review findings"
    sed -i.bak 's/  return cartTotal(items);/  if (items.length === 0) return 0;\n  return cartTotal(items);/' src/checkout.ts
    rm src/checkout.ts.bak
    git commit -qam "fix: verify round 1 fix"
    printf '# Shop\n\nA tiny shopping cart with discounts and checkout.\n' > README.md
    git commit -qam "chore: wip before review"
    pre="$(git rev-parse HEAD)"
    mkdir -p .harness/demo
    git log --reverse --format='%h %s%n%b' "$base..$pre" > .harness/demo/working-commits.txt
    git reset -q --mixed "$base"
    git diff -z --name-only --no-renames --diff-filter=A "$base" "$pre" | xargs -0 git add -N --
    ;;
  5)
    add_discount
    printf 'node_modules/\n' > .gitignore
    mkdir -p .harness/demo
    printf '# Plan\n\n1. Add discounts.\n' > .harness/demo/plan.md
    ;;
  6)
    printf '{\n  "name": "shop",\n  "dependencies": { "zod": "^3.23.8" }\n}\n' > package.json
    printf '{\n  "name": "shop",\n  "lockfileVersion": 3,\n  "packages": {\n    "node_modules/zod": { "version": "3.23.8" }\n  }\n}\n' > package-lock.json
    printf 'import { z } from "zod";\n\nexport const ItemSchema = z.object({ sku: z.string(), price: z.number(), qty: z.number().int() });\n' > src/validate.ts
    printf 'import { test, expect } from "vitest";\nimport { ItemSchema } from "./validate";\n\ntest("rejects a fractional qty", () => {\n  expect(ItemSchema.safeParse({ sku: "a", price: 1, qty: 1.5 }).success).toBe(false);\n});\n' > src/validate.test.ts
    printf '# Shop\n\nA tiny shopping cart.\n' > README.md
    ;;
  *)
    echo "unknown eval id: $id" >&2
    exit 2
    ;;
esac
