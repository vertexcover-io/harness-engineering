# Design Doc: Webhook Retry System

**Status:** Approved
**Date:** 2026-03-18
**Author:** Priya Sharma

## Context

Our platform sends webhooks to customer endpoints for events like payment completed, subscription changed, and invoice generated. Currently, if a webhook delivery fails, we log it and move on. Customers lose events and file support tickets. We need a retry system with exponential backoff.

## Proposed Solution

### Retry Queue

Failed webhook deliveries are placed into a retry queue. Each delivery attempt follows an exponential backoff schedule:

- Attempt 1: immediate
- Attempt 2: 30 seconds
- Attempt 3: 2 minutes
- Attempt 4: 15 minutes
- Attempt 5: 1 hour
- Attempt 6: 4 hours
- Attempt 7 (final): 24 hours

After all 7 attempts fail, the webhook is marked as "permanently failed" and the customer is notified via email.

### Delivery Semantics

- Webhooks are delivered at-least-once. Customers must handle idempotency using the event ID in the payload.
- Each webhook payload includes: event_id (UUID), event_type, timestamp, attempt_number, and the event data.
- A delivery is considered successful if the endpoint returns HTTP 2xx within 10 seconds.
- HTTP 3xx redirects are NOT followed - treated as failures.
- HTTP 4xx (except 429) are treated as permanent failures - no further retries.
- HTTP 429 follows the Retry-After header if present, otherwise uses the backoff schedule.
- HTTP 5xx and network errors trigger retries per the backoff schedule.

### Customer Dashboard

Customers can view their webhook delivery history:
- List of recent deliveries with status (delivered, retrying, failed)
- Ability to manually retry a permanently failed webhook
- Ability to view the payload that was sent
- Endpoint health indicator showing success rate over the last 24 hours

### Circuit Breaker

If an endpoint fails 10 consecutive deliveries across any events, the circuit breaker opens:
- New webhooks for that endpoint are queued but not delivered
- Every 5 minutes, a single probe delivery is attempted
- If the probe succeeds, the circuit closes and queued webhooks are delivered in order
- Customer is notified via email when their endpoint circuit breaker opens

## Constraints

- Retry queue must survive process restarts (persistent storage required)
- Maximum payload size is 256KB - larger events include a URL to fetch the full payload
- Webhook signing using HMAC-SHA256 so customers can verify authenticity
- Total system must handle 10,000 webhook deliveries per minute at peak
