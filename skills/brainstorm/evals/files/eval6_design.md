# Design: Session Management Rework

## Problem
Login sessions are stored in signed cookies; support cannot revoke a compromised session.

## Chosen Approach
Sessions move to Redis, keyed by session id. The cookie holds only the id.
Sessions expire after 24h of inactivity. Redis is configured with allkeys-lru
eviction so memory stays bounded.

## Requirements
- The security team can revoke any active session from the admin panel.
- Auditors can review 90 days of session history (login, logout, revocation events).

## Notes
We'll reuse the existing `redis_client` wrapper. Revocation UI goes in the
existing admin panel. We assume peak concurrent sessions stay under 50k.

<!-- Planted flaws:
     1. Contradiction: allkeys-lru eviction + 24h expiry vs "90 days of session
        history" — the audit requirement cannot be met by the session store as designed.
     2. Inferred-but-unmarked decisions: Redis over DB-backed sessions was never
        argued; 24h inactivity window chosen silently; eviction policy chosen silently.
     3. Unverified assumption: 50k concurrent sessions has no source.
     4. Missing: what happens to in-flight sessions during the migration. -->
