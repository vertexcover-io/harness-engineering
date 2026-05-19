# Design Doc: Rate Limiting for Public API

**Status:** Approved
**Date:** 2026-03-20
**Author:** Jamie Chen

## Context

Our public API currently has no rate limiting. During the last traffic spike, a single client made 50k requests/minute and degraded service for all users. We need per-client rate limiting to protect the platform.

## Proposed Solution

### Token Bucket Algorithm

Each API client gets a token bucket with a configurable capacity and refill rate. Tokens are consumed per request. When the bucket is empty, requests are rejected with HTTP 429.

- Default capacity: 100 tokens
- Default refill rate: 10 tokens/second
- Configurable per API key via the admin dashboard

### Behavior

- Each API key has its own independent bucket
- Requests without an API key use a shared IP-based bucket with lower limits (20 tokens, 2/sec refill)
- When rate limited, the response includes a `Retry-After` header with seconds until next available token
- Rate limit state is stored in Redis with TTL matching the bucket window
- If Redis is unavailable, requests are allowed through (fail-open) to avoid total API outage

### Tiers

| Tier | Capacity | Refill Rate |
|------|----------|-------------|
| Free | 100 | 10/sec |
| Pro | 1000 | 100/sec |
| Enterprise | 10000 | 1000/sec |

### Monitoring

- Emit metrics for: total requests, rate-limited requests, current bucket fill levels
- Alert when any single client exceeds 80% of their limit sustained over 5 minutes
- Dashboard showing top consumers and rate limit hit frequency

## Integration Points

- API Gateway (nginx) adds client identification headers
- Redis cluster for state storage
- Prometheus for metrics emission
- Admin dashboard for per-key configuration

## Constraints

- Must not add more than 5ms of latency to any request
- Must handle Redis failover gracefully
- Configuration changes must take effect within 30 seconds without restart
- Must be backward compatible - existing clients with no API key still work (just with lower limits)

## Open Questions

- Should we support burst allowances above the capacity?
- Do we need webhook notifications when clients approach their limits?
