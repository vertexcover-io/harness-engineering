# Tech Stack Spec: TaskFlow

## Overview
TaskFlow is a task management SaaS with a Next.js web app, Hono API server, and shared utilities package.

## Package Manager
pnpm

## Monorepo Structure

```
packages/
  web/          — Next.js 14 frontend (App Router)
  api/          — Hono REST API server
  shared/       — Shared TypeScript types, validators, and utilities
```

## Packages

### @taskflow/web
- **Framework:** Next.js 14 with App Router
- **Purpose:** Web dashboard for managing tasks
- **Dependencies:** @taskflow/shared

### @taskflow/api
- **Framework:** Hono (running on Node.js)
- **Purpose:** REST API serving task CRUD, user auth
- **Dependencies:** @taskflow/shared, drizzle-orm (PostgreSQL), ioredis
- **Health check:** GET /health returns `{ status: "ok" }`

### @taskflow/shared
- **Purpose:** Shared TypeScript types, Zod schemas for task/user models, utility functions
- **No framework** — pure TypeScript library built with tsup

## Infrastructure

### PostgreSQL 16
- Port: 5432
- Database: taskflow_dev
- User: taskflow / password: taskflow

### Redis 7
- Port: 6379
- Used for session cache and rate limiting

## Environment Variables
- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis connection string
- `API_PORT` — Port for the API server (default 3001)
- `NEXT_PUBLIC_API_URL` — API URL for the frontend
