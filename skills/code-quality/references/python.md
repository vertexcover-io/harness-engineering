# Python Strict Patterns

Language-specific patterns for Python. Read alongside the main SKILL.md.

---

## Table of Contents

1. [Type Checking Configuration](#type-checking-configuration)
2. [No `Any` — Ever](#no-any--ever)
3. [Frozen Dataclasses for Immutability](#frozen-dataclasses-for-immutability)
4. [Pydantic for Validation at Boundaries](#pydantic-for-validation-at-boundaries)
5. [Protocol for Behavior Contracts](#protocol-for-behavior-contracts)
6. [Result Type for Error Handling](#result-type-for-error-handling)
7. [Dependency Injection](#dependency-injection)
8. [Functional Patterns in Python](#functional-patterns-in-python)
9. [Structural Pattern Matching](#structural-pattern-matching)
10. [NewType for Domain Primitives](#newtype-for-domain-primitives)
11. [Testing with pytest](#testing-with-pytest)
12. [File Organization](#file-organization)
13. [Checklist](#checklist)

---

## Type Checking Configuration

Use Pyright (preferred) or mypy in strict mode. Every Python file must pass strict type checking.

### Pyright (pyrightconfig.json)

```json
{
  "typeCheckingMode": "strict",
  "reportMissingTypeStubs": true,
  "reportUnusedImport": "error",
  "reportUnusedVariable": "error",
  "reportMissingParameterType": "error",
  "reportUnnecessaryTypeIgnoreComment": "error"
}
```

### mypy (mypy.ini or pyproject.toml)

```ini
[mypy]
strict = true
warn_return_any = true
warn_unused_configs = true
disallow_any_generics = true
disallow_untyped_defs = true
check_untyped_defs = true
no_implicit_optional = true
```

Type checking applies to test code as well as production code. No `# type: ignore` without an explicit comment explaining why.

---

## No `Any` — Ever

`Any` disables the type checker for everything it touches, just like `any` in TypeScript. It propagates silently through return types and assignments.

```python
# BAD — Any disables checking
from typing import Any

def process(data: Any) -> Any:
    return data["key"]["nested"]  # No error, crashes at runtime

# GOOD — use object and narrow
def process(data: object) -> str:
    if not isinstance(data, dict):
        raise ValueError("Expected dict")
    value = data.get("key")
    if not isinstance(value, str):
        raise ValueError("Expected string")
    return value
```

**`cast()` is equally dangerous** — it tells the type checker "trust me" without any runtime check:

```python
# BAD — cast bypasses checking
from typing import cast
user = cast(User, response)

# GOOD — validate at runtime
def parse_user(data: object) -> User:
    return UserModel.model_validate(data)
```

Use `object` instead of `Any` when the type is truly unknown. Use generics (`TypeVar`, `ParamSpec`) for generic functions.

---

## Frozen Dataclasses for Immutability

All data structures should be frozen dataclasses. This prevents mutation at runtime and signals immutability at the type level.

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class User:
    id: str
    email: str
    name: str
    roles: tuple[str, ...]  # tuple, not list — immutable

@dataclass(frozen=True)
class Order:
    id: str
    user_id: str
    items: tuple[OrderItem, ...]
    total: float
    status: OrderStatus
```

**Key patterns:**
- Use `tuple[T, ...]` instead of `list[T]` for immutable sequences
- Use `frozenset[T]` instead of `set[T]` for immutable sets
- Use `MappingProxyType` or frozen Pydantic models for immutable dicts
- Use `dataclasses.replace()` for copy-with-modification

```python
from dataclasses import replace

updated_user = replace(user, name="New Name")
# user is unchanged, updated_user has the new name
```

---

## Pydantic for Validation at Boundaries

Use Pydantic models at trust boundaries where external data enters the system. Derive types from models.

```python
from pydantic import BaseModel, EmailStr

class CreateUserRequest(BaseModel):
    model_config = {"frozen": True}

    email: EmailStr
    name: str

# Validate at boundary
def create_user_endpoint(body: dict[str, object]) -> User:
    request = CreateUserRequest.model_validate(body)
    return user_service.create(request.email, request.name)
```

**When Pydantic IS required:**
- API request/response bodies
- Configuration from files or environment
- Data from external services
- User input

**When Pydantic is NOT required:**
- Internal data structures (use frozen dataclasses)
- Function parameters between your own modules
- Return types of pure functions

**Key rule**: Define validation models once. Never duplicate validation logic across multiple files.

---

## Protocol for Behavior Contracts

Use `Protocol` for structural typing — Python's equivalent of TypeScript's `interface`. Protocols define what an object can do without requiring inheritance.

```python
from typing import Protocol

class UserRepository(Protocol):
    def find_by_id(self, user_id: str) -> User | None: ...
    def save(self, user: User) -> None: ...
    def delete(self, user_id: str) -> None: ...

class PaymentGateway(Protocol):
    def charge(self, amount: float, payment_info: PaymentInfo) -> Result[Transaction]: ...
```

**Why Protocol over ABC:**
- Structural typing — implementations don't need to inherit from anything
- Works with existing classes that happen to match the protocol
- Better for dependency injection — any object with matching methods works
- More Pythonic (duck typing with type safety)

```python
# This works without any inheritance or registration
class PostgresUserRepository:
    def find_by_id(self, user_id: str) -> User | None:
        # ...
    def save(self, user: User) -> None:
        # ...
    def delete(self, user_id: str) -> None:
        # ...

# Type checker verifies PostgresUserRepository satisfies UserRepository protocol
def create_user_service(repo: UserRepository) -> UserService:
    # ...
```

---

## Result Type for Error Handling

Use a discriminated union for expected errors:

```python
from dataclasses import dataclass
from typing import Generic, TypeVar

T = TypeVar("T")
E = TypeVar("E")

@dataclass(frozen=True)
class Success(Generic[T]):
    data: T

@dataclass(frozen=True)
class Failure(Generic[E]):
    error: E

type Result[T, E] = Success[T] | Failure[E]

# Usage
def find_user(user_id: str) -> Result[User, str]:
    user = database.find_by_id(user_id)
    if user is None:
        return Failure("User not found")
    return Success(user)

# Caller handles both cases
match find_user("123"):
    case Success(data=user):
        print(user.email)
    case Failure(error=msg):
        print(f"Error: {msg}")
```

For Python < 3.12, use `Union[Success[T], Failure[E]]` instead of the `type` alias syntax.

Reserve `raise` for programmer errors (assertion failures, invariant violations) where recovery isn't expected.

---

## Dependency Injection

Inject dependencies through function parameters or constructor arguments. Never import and instantiate them internally.

```python
# BAD — hardcoded dependency
def create_order_processor(
    payment_gateway: PaymentGateway,
) -> OrderProcessor:
    order_repo = InMemoryOrderRepository()  # hardcoded!
    # ...

# GOOD — all dependencies injected
def create_order_processor(
    *,
    payment_gateway: PaymentGateway,
    order_repository: OrderRepository,
) -> OrderProcessor:
    # ...
```

Use keyword-only arguments (`*`) for dependency injection to make call sites explicit.

---

## Functional Patterns in Python

### List Comprehensions Over Loops

Python's comprehensions are the idiomatic equivalent of `map`/`filter`:

```python
# Transform
emails = [u.email for u in users]

# Filter
active = [u for u in users if u.is_active]

# Filter + transform
active_emails = [u.email for u in users if u.is_active]

# Dict comprehension
user_by_id = {u.id: u for u in users}
```

### functools for Composition

```python
from functools import reduce

# Aggregate
total = reduce(lambda acc, item: acc + item.price * item.quantity, items, 0.0)

# Or use sum with a generator
total = sum(item.price * item.quantity for item in items)
```

### Immutable Updates

```python
from dataclasses import replace

# Update a field
updated = replace(user, name="New Name")

# Update nested — create new parent with new child
updated_order = replace(
    order,
    items=tuple(
        replace(item, quantity=new_qty) if item.id == target_id else item
        for item in order.items
    ),
)

# Dict merge (Python 3.9+)
updated_config = base_config | {"key": "new_value"}
```

### Pure Functions

```python
# GOOD — pure function
def calculate_total(items: tuple[OrderItem, ...]) -> float:
    return sum(item.price * item.quantity for item in items)

# BAD — impure (mutates argument)
def add_item(items: list[OrderItem], item: OrderItem) -> None:
    items.append(item)

# GOOD — pure (returns new tuple)
def add_item(items: tuple[OrderItem, ...], item: OrderItem) -> tuple[OrderItem, ...]:
    return (*items, item)
```

---

## Structural Pattern Matching

Python 3.10+ pattern matching is powerful for handling discriminated unions and complex data:

```python
match result:
    case Success(data=user):
        return create_response(user)
    case Failure(error=ValidationError() as e):
        return error_response(400, str(e))
    case Failure(error=NotFoundError() as e):
        return error_response(404, str(e))
    case Failure(error=e):
        return error_response(500, str(e))
```

Pattern matching replaces chains of `isinstance` checks and nested `if/elif/else` with declarative, exhaustive handling.

---

## NewType for Domain Primitives

Use `NewType` to create type-safe wrappers around primitives:

```python
from typing import NewType

UserId = NewType("UserId", str)
OrderId = NewType("OrderId", str)
PaymentAmount = NewType("PaymentAmount", float)

def process_payment(user_id: UserId, amount: PaymentAmount) -> Result[Transaction, str]:
    # ...

# Type checker catches mixing up IDs
user_id = UserId("user-123")
order_id = OrderId("order-456")
process_payment(order_id, PaymentAmount(100.0))  # Type error!
```

`NewType` has zero runtime cost — it's erased at runtime. Use it when you have multiple primitives of the same base type that could be confused.

---

## Testing with pytest

### Fixtures for Dependency Injection

```python
import pytest

@pytest.fixture
def user_repository() -> InMemoryUserRepository:
    return InMemoryUserRepository()

@pytest.fixture
def user_service(user_repository: UserRepository) -> UserService:
    return create_user_service(repository=user_repository)
```

### Parametrize for Variations

```python
@pytest.mark.parametrize(
    "email,expected_valid",
    [
        ("user@example.com", True),
        ("invalid", False),
        ("", False),
        ("user@.com", False),
    ],
)
def test_email_validation(email: str, expected_valid: bool) -> None:
    result = validate_email(email)
    assert result == expected_valid
```

### Factory Functions for Test Data

```python
def make_user(
    *,
    id: str = "user-123",
    email: str = "test@example.com",
    name: str = "Test User",
    roles: tuple[str, ...] = ("reader",),
) -> User:
    return User(id=id, email=email, name=name, roles=roles)
```

Use keyword-only arguments in factories. Override only what the test cares about.

---

## File Organization

Common patterns for Python projects:

| Category              | Common locations                                      | Examples                                     |
|-----------------------|-------------------------------------------------------|----------------------------------------------|
| Protocols (contracts) | `src/interfaces/`, `src/ports/`, co-located            | `UserRepository`, `PaymentGateway`           |
| Data structures       | `src/types/`, `src/models/`, `src/domain/`             | `User`, `Order`, `Config`                    |
| Validation models     | `src/schemas/`, `src/validation/`, co-located           | `CreateUserRequest`, `OrderSchema`           |
| Business logic        | `src/services/`, `src/domain/`, `src/use_cases/`       | `create_user_service`, `process_order`       |
| Implementations       | `src/adapters/`, `src/infrastructure/`, `src/repos/`   | `PostgresUserRepo`, `StripeGateway`          |

Key principle: Dependencies point inward. Infrastructure depends on domain, never the reverse.

---

## Checklist

Python-specific checks (in addition to the main SKILL.md checklist):

- [ ] Strict type checking enabled (Pyright strict or mypy --strict)
- [ ] No `Any` types anywhere
- [ ] No `cast()` without a runtime validation alternative
- [ ] No `# type: ignore` without explicit justification comment
- [ ] All data structures are `@dataclass(frozen=True)`
- [ ] `tuple[T, ...]` instead of `list[T]` for immutable sequences
- [ ] `frozenset[T]` instead of `set[T]` for immutable sets
- [ ] `Protocol` for behavior contracts (not ABC)
- [ ] Pydantic models at trust boundaries, frozen dataclasses internally
- [ ] `NewType` for domain-specific primitives that could be confused
- [ ] Keyword-only arguments (`*`) for functions with 3+ parameters
- [ ] `dataclasses.replace()` for immutable updates (not mutation)
- [ ] `pytest` with fixtures and parametrize for testing
