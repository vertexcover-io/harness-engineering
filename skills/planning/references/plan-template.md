# Plan Template Reference

Annotated examples for the plan folder structure.

---

## plan.md Example

```markdown
# Plan: User Authentication System

> **Source:** `docs/plans/2026-02-20-auth-design.md`
> **Created:** 2026-02-24
> **Status:** in-progress

## Goal

Add JWT-based authentication with login, registration, and token refresh.

## Acceptance Criteria

- [ ] Users can register with email and password
- [ ] Users can log in and receive a JWT token
- [ ] Protected endpoints reject unauthenticated requests
- [ ] Tokens expire and can be refreshed

## Codebase Context

### Existing Patterns to Follow

- **API endpoints**: `src/routes/health.py` — request validation, service call, response
- **Data models**: `src/models/session.py` — Pydantic BaseModel with validators
- **Service layer**: `src/services/usage_service.py` — business logic with injected deps

### Test Infrastructure

- Test runner: `pytest` with `pytest-asyncio`
- Fixtures: `tests/conftest.py` — `test_client`, `mock_config`
- Run: `uv run pytest tests/ -v`

## Phases

| # | Phase | Status | Depends On |
|---|-------|--------|------------|
| 1 | User model, storage, and test factories | complete | — |
| 2 | Registration endpoint with validation | in-progress | Phase 1 |
| 3 | Login endpoint with JWT token generation | pending | Phase 1 |
| 4 | Auth middleware and protected endpoints | pending | Phase 2, 3 |
| 5 | Token refresh and expiration handling | pending | Phase 4 |

## Phase Dependency Graph

Phase 1 --+--> Phase 2 --\
           |               +--> Phase 4 --> Phase 5
           +--> Phase 3 --/

## Notes

- Phase 2 and 3 can run in parallel after Phase 1 completes
- JWT secret should come from environment config, not hardcoded
```

---

## phase-N.md Example

```markdown
# Phase 2: Registration Endpoint with Validation

> **Status:** pending
> **Depends on:** Phase 1

## Overview

Build user registration. After this phase, new users can create accounts by
submitting email and password. Validates input, hashes passwords, rejects
duplicates, and never exposes passwords in responses.

## Implementation

**Files:**
- Create: `src/routes/registration.py`
- Create: `src/services/auth_service.py`
- Create: `tests/test_registration.py`
- Modify: `src/routes/__init__.py` — register new route

**Pattern to follow:** `src/routes/health.py` for route structure,
`src/services/usage_service.py` for service layer.

**What to test:**
- Rejects missing email (422)
- Rejects weak password — min 8 chars, uppercase, lowercase, digit (422)
- Successful registration returns user without password (201)
- Duplicate email rejected (409)

**What to build:**
Registration route accepting `{email, password}`. Pydantic request model with
EmailStr and password validator. Auth service with `register()` that hashes
password and persists user.

Password hashing — include because salt rounds and verify function matter:

```python
import bcrypt

def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt(rounds=12)).decode()

def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())
```

**Commit:** `feat(auth): add registration endpoint with validation`

## Done When

- [ ] All 4 test cases pass
- [ ] Existing tests still pass
- [ ] No password exposed in any API response
```

---

## @fix Tag Examples

```markdown
<!-- @fix: use argon2 instead of bcrypt — already a project dependency -->
Password hashing — include because salt rounds matter:

<!-- @fix: split webhook delivery into its own phase — this is too large -->
## Overview
This phase implements notifications: email, SMS, and webhook delivery.
```
