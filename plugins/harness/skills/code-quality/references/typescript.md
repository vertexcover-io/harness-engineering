# TypeScript Strict Patterns

Language-specific patterns for TypeScript. Read alongside the main SKILL.md.

---

## Table of Contents

1. [Strict Mode Configuration](#strict-mode-configuration)
2. [No `any` — Ever](#no-any--ever)
3. [Type vs Interface](#type-vs-interface)
4. [Schema-First at Trust Boundaries](#schema-first-at-trust-boundaries)
5. [Immutability with `readonly`](#immutability-with-readonly)
6. [Factory Functions Over Classes](#factory-functions-over-classes)
7. [Dependency Injection](#dependency-injection)
8. [Result Type for Error Handling](#result-type-for-error-handling)
9. [Branded Types](#branded-types)
10. [Immutable Operations Catalog](#immutable-operations-catalog)
11. [Functional Array Methods](#functional-array-methods)
12. [Options Objects](#options-objects)
13. [File Organization](#file-organization)
14. [Checklist](#checklist)

---

## Strict Mode Configuration

Every TypeScript project must use strict mode with additional safety flags:

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true,
    "forceConsistentCasingInFileNames": true,
    "allowUnusedLabels": false
  }
}
```

Key flags and why they matter:

- **`noUncheckedIndexedAccess`**: Array/object access returns `T | undefined`, preventing runtime errors from assuming elements exist
- **`exactOptionalPropertyTypes`**: Distinguishes `property?: T` from `property: T | undefined` for more precise types
- **`noPropertyAccessFromIndexSignature`**: Forces bracket notation for index signatures, making dynamic access explicit
- **`noUnusedParameters`**: Catches design issues — unused parameters often indicate the parameter belongs in a different layer

These rules apply to test code as well as production code. No `@ts-ignore` without an explicit comment explaining why.

---

## No `any` — Ever

`any` disables the type checker for everything it touches. It propagates silently — a single `any` can infect an entire call chain.

```typescript
// BAD — any disables all type checking
function process(data: any) {
  return data.foo.bar.baz; // No error, crashes at runtime
}

// GOOD — unknown forces you to narrow
function process(data: unknown) {
  if (!isValidPayload(data)) {
    return { success: false, error: new Error('Invalid payload') };
  }
  return { success: true, data: data.value };
}
```

**Type assertions (`as Type`)** are almost as dangerous. They tell the compiler "trust me" — and you're usually wrong. If you need an assertion, write a type guard instead:

```typescript
// BAD — assertion bypasses checking
const user = response as User;

// GOOD — type guard validates at runtime
function isUser(value: unknown): value is User {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'email' in value
  );
}
```

---

## Type vs Interface

This is an architectural choice, not a stylistic one.

### `type` — for data structures

Data that flows through the system. Immutable, composable, supports unions and intersections.

```typescript
type User = {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly roles: ReadonlyArray<string>;
};

type Result<T, E = Error> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: E };
```

### `interface` — for behavior contracts

Contracts that define what something can do. Used at architectural boundaries for dependency inversion.

```typescript
interface UserRepository {
  findById(id: string): Promise<User | undefined>;
  save(user: User): Promise<void>;
  delete(id: string): Promise<void>;
}

interface PaymentGateway {
  charge(amount: number, paymentInfo: PaymentInfo): Promise<Result<Transaction>>;
}
```

**Why this distinction matters**: `interface` communicates "this must be implemented elsewhere" — it's a seam in the architecture. `type` communicates "this is data" — it's a value that flows through the system. Mixing them obscures architecture.

---

## Schema-First at Trust Boundaries

Define schemas first, derive types from them. Use Zod or a Standard Schema compatible library.

### When schemas ARE required

- External data enters the system (API requests, file reads, env vars, user input)
- Data has validation rules (format, constraints, ranges)
- Shared contracts between systems

```typescript
import { z } from 'zod';

const CreateUserRequestSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
});

type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

// Validate at boundary
const validated = CreateUserRequestSchema.parse(requestBody);
```

### When schemas are NOT required

- Pure internal types (utilities, state)
- Result/Option types
- Behavior contracts (interfaces)
- Component props (unless from URL/API)

**Key rule**: Define schemas once in a centralized location. Never duplicate validation logic across multiple files. Import the schema wherever you need it.

---

## Immutability with `readonly`

Mark all data structure properties as `readonly`. Use `ReadonlyArray<T>` instead of `T[]`.

```typescript
type Order = {
  readonly id: string;
  readonly userId: string;
  readonly items: ReadonlyArray<OrderItem>;
  readonly total: number;
  readonly status: OrderStatus;
};

type OrderItem = {
  readonly productId: string;
  readonly quantity: number;
  readonly price: number;
};
```

Nested structures need `readonly` at every level:

```typescript
type Config = {
  readonly server: {
    readonly host: string;
    readonly port: number;
  };
  readonly features: ReadonlyArray<{
    readonly name: string;
    readonly enabled: boolean;
  }>;
};
```

`readonly` catches mutation bugs at compile time and signals intent to other developers.

---

## Factory Functions Over Classes

Use factory functions for object creation. They align with functional patterns, avoid `this` context issues, and make dependency injection natural.

```typescript
// GOOD — factory function
const createOrderService = ({
  orderRepository,
  paymentGateway,
}: {
  orderRepository: OrderRepository;
  paymentGateway: PaymentGateway;
}): OrderService => ({
  async createOrder(order) {
    const validation = validateOrder(order);
    if (!validation.success) return validation;
    await orderRepository.save(order);
    return { success: true, data: order };
  },

  async processPayment(orderId, paymentInfo) {
    const order = await orderRepository.findById(orderId);
    if (!order) {
      return { success: false, error: new Error('Order not found') };
    }
    return paymentGateway.charge(order.total, paymentInfo);
  },
});

// BAD — class with this
class OrderService {
  constructor(
    private orderRepository: OrderRepository,
    private paymentGateway: PaymentGateway,
  ) {}
  // ...
}
```

---

## Dependency Injection

All dependencies are injected via parameters. Never create implementations internally.

```typescript
// BAD — hardcoded dependency
const createOrderProcessor = ({
  paymentGateway,
}: {
  paymentGateway: PaymentGateway;
}): OrderProcessor => {
  const orderRepository = new InMemoryOrderRepository(); // hardcoded!
  return { /* ... */ };
};

// GOOD — all dependencies injected
const createOrderProcessor = ({
  paymentGateway,
  orderRepository,
}: {
  paymentGateway: PaymentGateway;
  orderRepository: OrderRepository;
}): OrderProcessor => {
  return { /* ... */ };
};
```

Injected dependencies make testing trivial (pass mocks), make the dependency graph explicit, and allow swapping implementations without changing business logic.

---

## Result Type for Error Handling

Use a discriminated union for expected errors:

```typescript
type Result<T, E = Error> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: E };

const findUser = (userId: string): Result<User> => {
  const user = database.findById(userId);
  if (!user) {
    return { success: false, error: new Error('User not found') };
  }
  return { success: true, data: user };
};

// Caller must handle both cases
const result = findUser('123');
if (!result.success) {
  console.error(result.error);
  return;
}
// TypeScript knows result.data exists here
console.log(result.data.email);
```

Reserve `throw` for programmer errors (invariant violations, assertion failures) where recovery isn't expected.

---

## Branded Types

For type-safe primitives that prevent mixing up string/number values:

```typescript
type UserId = string & { readonly brand: unique symbol };
type OrderId = string & { readonly brand: unique symbol };
type PaymentAmount = number & { readonly brand: unique symbol };

const processPayment = (userId: UserId, amount: PaymentAmount) => {
  // ...
};

// Can't accidentally pass an OrderId where UserId is expected
const userId = 'user-123' as UserId;
const amount = 100 as PaymentAmount;
processPayment(userId, amount);
```

Branded types are most valuable when you have multiple IDs or quantities that could be confused at call sites.

---

## Immutable Operations Catalog

Complete reference for replacing mutations with immutable alternatives:

```typescript
// --- Arrays ---
// Add to end:     [...items, newItem]
// Add to start:   [newItem, ...items]
// Remove last:    items.slice(0, -1)
// Remove first:   items.slice(1)
// Remove at index:
//   [...items.slice(0, index), ...items.slice(index + 1)]
// Insert at index:
//   [...items.slice(0, index), newItem, ...items.slice(index)]
// Update at index:
//   items.map((item, i) => i === index ? newValue : item)
// Reverse:        [...items].reverse()
// Sort:           [...items].sort(compareFn)
// Remove by ID:   items.filter(item => item.id !== targetId)
// Replace by ID:  items.map(item => item.id === targetId ? newItem : item)

// --- Objects ---
// Update property:       { ...user, name: "New" }
// Remove property:       const { removed, ...rest } = obj
// Merge:                 { ...defaults, ...overrides }

// --- Nested ---
// Update nested property:
const updated = {
  ...order,
  shipping: { ...order.shipping, address: newAddress },
};
// Update item in nested array:
const updated = {
  ...cart,
  items: cart.items.map((item, i) =>
    i === targetIndex ? { ...item, quantity: newQuantity } : item
  ),
};
```

---

## Functional Array Methods

Use `map`, `filter`, `reduce` over imperative loops:

```typescript
// Transform
const emails = users.map(u => u.email);

// Filter
const active = users.filter(u => u.isActive);

// Aggregate
const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

// Chain
const activeEmails = users
  .filter(u => u.isActive)
  .map(u => u.email);

// Find (early termination)
const admin = users.find(u => u.role === 'admin');

// Check conditions
const allVerified = users.every(u => u.verified);
const hasAdmin = users.some(u => u.role === 'admin');
```

Loops are acceptable when early termination with side effects is needed and no declarative alternative exists.

---

## Options Objects

Use an options object when a function takes 3+ parameters:

```typescript
// BAD — positional parameters
function createPayment(
  amount: number,
  currency: string,
  cardId: string,
  cvv: string,
  saveCard: boolean,
  sendReceipt: boolean,
): Payment { /* ... */ }

createPayment(100, 'GBP', 'card_123', '123', true, false); // what do true/false mean?

// GOOD — options object
type CreatePaymentOptions = {
  readonly amount: number;
  readonly currency: string;
  readonly cardId: string;
  readonly cvv: string;
  readonly saveCard?: boolean;
  readonly sendReceipt?: boolean;
};

function createPayment(options: CreatePaymentOptions): Payment {
  const { amount, currency, cardId, cvv, saveCard = false, sendReceipt = true } = options;
  // ...
}

createPayment({
  amount: 100,
  currency: 'GBP',
  cardId: 'card_123',
  cvv: '123',
  saveCard: true,
});
```

Positional parameters are fine for 1-2 parameters with obvious ordering (e.g., `add(a, b)`).

---

## File Organization

Common patterns for organizing TypeScript projects. Adapt to your project's conventions.

| Category              | Common locations                                    | Examples                                    |
|-----------------------|-----------------------------------------------------|---------------------------------------------|
| Behavior contracts    | `src/interfaces/`, `src/contracts/`, `src/ports/`   | `UserRepository`, `PaymentGateway`          |
| Data structures       | `src/types/`, `src/models/`, co-located              | `User`, `Order`, `Config`                   |
| Validation schemas    | `src/schemas/`, `src/validation/`, co-located        | `UserSchema`, `OrderSchema`                 |
| Business logic        | `src/services/`, `src/domain/`, `src/use-cases/`    | `createUserService`, `processOrder`         |
| Implementations       | `src/adapters/`, `src/infrastructure/`, `src/repos/` | `PostgresUserRepo`, `StripePaymentGateway`  |

Key principle: Dependencies point inward (toward business logic). Infrastructure depends on domain, never the reverse.

---

## Checklist

TypeScript-specific checks (in addition to the main SKILL.md checklist):

- [ ] Strict mode enabled with all safety flags
- [ ] No `any` types anywhere
- [ ] No `as Type` assertions without a type guard alternative
- [ ] No `@ts-ignore` without explicit justification comment
- [ ] `type` for data structures, `interface` for behavior contracts
- [ ] `readonly` on all type properties
- [ ] `ReadonlyArray<T>` instead of `T[]`
- [ ] Schemas defined once, derived types with `z.infer`
- [ ] Factory functions instead of classes
- [ ] Options objects for functions with 3+ parameters
- [ ] Branded types for domain-specific primitives that could be confused
