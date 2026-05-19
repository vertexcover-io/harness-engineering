# CLAUDE.md

## Project Overview

A Python web API built with FastAPI. Uses PostgreSQL for storage and Redis for caching.

## Architecture

- `src/api/` — Route handlers
- `src/models/` — SQLAlchemy models
- `src/services/` — Business logic layer
- `tests/` — Pytest test suite

## Development

```bash
# Run the server
uvicorn src.main:app --reload

# Run tests
pytest tests/

# Lint
ruff check src/
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | Redis connection string |
| `JWT_SECRET` | Yes | Secret key for JWT tokens |

## Key Patterns

- All route handlers go in `src/api/`
- Business logic lives in `src/services/`, never in route handlers
- Models use SQLAlchemy ORM with Alembic migrations
- Tests use pytest fixtures with a test database
