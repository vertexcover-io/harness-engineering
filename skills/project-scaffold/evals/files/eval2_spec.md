# Tech Stack Spec: MediaPipe

## Overview
MediaPipe is a media processing platform with separate ingest and transcode workers, a gateway API, and a shared database layer.

## Package Manager
npm

## Monorepo Structure

```
packages/
  gateway/      — Fastify API gateway
  ingest/       — Media ingest worker (BullMQ consumer)
  transcode/    — Transcode worker (BullMQ consumer)
  db/           — Drizzle ORM schema, migrations, and DB client
```

## Packages

### @mediapipe/gateway
- **Framework:** Fastify
- **Purpose:** Public-facing API. Accepts upload requests, enqueues jobs
- **Dependencies:** @mediapipe/db, bullmq
- **Health check:** GET /healthz returns 200

### @mediapipe/ingest
- **Framework:** None (plain Node.js + BullMQ worker)
- **Purpose:** Consumes upload jobs from the ingest queue, validates files, writes metadata to DB
- **Dependencies:** @mediapipe/db, bullmq

### @mediapipe/transcode
- **Framework:** None (plain Node.js + BullMQ worker)
- **Purpose:** Consumes transcode jobs, calls ffmpeg, updates status in DB
- **Dependencies:** @mediapipe/db, bullmq

### @mediapipe/db
- **Purpose:** Drizzle ORM schema definitions, migration scripts, shared DB client
- **Dependencies:** drizzle-orm, drizzle-kit, pg

## Infrastructure

### PostgreSQL 16
- Port: 5433
- Database: mediapipe_dev
- User: mediapipe / password: mediapipe

### Redis 7
- Port: 6380
- Used as BullMQ backing store for job queues

### MinIO (S3-compatible object storage)
- API Port: 9000
- Console Port: 9001
- Bucket: media-uploads
- Access Key: minioadmin / Secret Key: minioadmin

## Environment Variables
- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis connection string
- `S3_ENDPOINT` — MinIO endpoint URL
- `S3_ACCESS_KEY` — MinIO access key
- `S3_SECRET_KEY` — MinIO secret key
- `S3_BUCKET` — Default bucket name
- `GATEWAY_PORT` — Gateway API port (default 4000)
