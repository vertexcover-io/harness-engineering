---
name: functional-verify
description: >
  Live functional verification. Starts application infrastructure, runs API tests via curl
  and UI tests via Playwright, captures evidence (payloads, responses, screenshots), and
  generates a proof report at docs/spec/<name>/verification/proof-report.md.
  Verification scenarios are read from the spec's "Verification Scenarios" section or
  derived from the plan. Use when verifying that implemented features actually work
  end-to-end, beyond unit/e2e test suites.
user-invocable: true
---

# Functional Verify: Live Application Testing

Verifies that implemented features work by running the application and testing it
like a user or API client would — not just running the test suite.

**Announce at start:** "Starting functional verification — running the application and testing features live."

---

## Inputs

- **Spec:** `docs/spec/<SPEC_NAME>/spec.md`
- **Plan dir:** `docs/spec/<SPEC_NAME>/`
- **Phase files:** `docs/spec/<SPEC_NAME>/phase-*.md`

---

## Step 1 — Read Verification Scenarios

Read the spec file. Look for a `## Verification Scenarios` section.

**If present:** Parse each `### VS-N: <description>` block. Extract:
- `**Type:**` (api | ui | db)
- `**Endpoint:**` or `**Route:**` (for api/ui)
- `**Payload:**` (for api — JSON body)
- `**Steps:**` (for ui — numbered list of actions)
- `**Expected:**` (status, content, behavior, redirects)
- `**DB check:**` (optional SQL/query + expected count/value)
- `**Screenshot at:**` (optional — which steps to capture)

**If absent:** Derive scenarios from the plan's acceptance criteria and phase files.
For each acceptance criterion, create one scenario:
- If it mentions API endpoints → type: api
- If it mentions pages/UI/routes → type: ui
- If it mentions data persistence → db check on relevant api/ui scenario

**If no scenarios can be derived** (spec has no Verification Scenarios section and plan
has no testable acceptance criteria): skip verification entirely. Report: "No functional
verification scenarios — skipping." Do NOT fabricate scenarios.

**Token rule:** Do NOT re-read the spec/plan files if already loaded. Reference from memory.

---

## Step 2 — Start Infrastructure

1. **Check if services are already running** (try all, proceed with whatever responds):
   ```
   curl -s -o /dev/null -w '%{http_code}' http://localhost:3000 2>/dev/null
   curl -s -o /dev/null -w '%{http_code}' http://localhost:3001 2>/dev/null
   curl -s -o /dev/null -w '%{http_code}' http://localhost:8080 2>/dev/null
   curl -s -o /dev/null -w '%{http_code}' http://localhost:8000 2>/dev/null
   # UI dev servers:
   curl -s -o /dev/null -w '%{http_code}' http://localhost:5173 2>/dev/null
   curl -s -o /dev/null -w '%{http_code}' http://localhost:4200 2>/dev/null
   ```

2. **If any required service is not running,** find startup commands:
   - Check `package.json` → `scripts.dev`, `scripts.start`, `scripts.start:api`, `scripts.start:dev`
   - Check `docker-compose.yml` / `compose.yml` → `docker compose up -d`
   - Check `Makefile` → `up`, `start`, `dev` targets
   
   Start in background:
   ```
   npm run dev &> /tmp/functional-verify-api.log &
   ```
   Or for docker:
   ```
   docker compose up -d --wait 2>&1
   ```

3. **Wait for health.** Poll the expected port until it responds (max 30s):
   ```
   for i in $(seq 1 30); do
     curl -s -o /dev/null http://localhost:<PORT> && break
     sleep 1
   done
   ```

4. **Cleanup note:** Services started by this skill should be killed after verification.
   Track PIDs or use `docker compose down` when done.

---

## Step 3 — Run API Verification

For each API scenario:

```
# Execute
curl -s -w '\n%{http_code}' -X <METHOD> http://localhost:<PORT>/<endpoint> \
  -H 'Content-Type: application/json' \
  -d '<PAYLOAD>' 2>&1

# Capture: exit code, HTTP status, response body (truncated to 50 lines)
```

**For each scenario record:**
- Scenario ID and description
- Exact curl command executed
- HTTP status code
- Response body (first 50 lines if long)
- Whether expected status/content matched
- PASSED / FAILED verdict

**DB verification (if scenario has `**DB check:**`):**
1. Check available MCP tools for database capabilities (look for psql, mongosh, sqlite3, etc.)
2. If MCP tool connected → use it directly
3. If not → read connection string from `.env` / `.env.local` / `docker-compose.yml`
4. Execute the check query and compare against expected value
5. Record result: actual value, expected value, PASSED / FAILED

**Save evidence:** Write each scenario's curl output to `docs/spec/<SPEC_NAME>/verification/api/<scenario-id>.txt`

---

## Step 4 — Run UI Verification

For each UI scenario:

**4a. Ensure Playwright is available:**
```
# Check
npx playwright --version 2>/dev/null || echo "NOT_INSTALLED"

# Install if needed
npm install -D @playwright/test 2>&1
npx playwright install chromium 2>&1
```

**4b. Create playwright.config.ts if absent:**
Check if `playwright.config.ts` exists at project root. If not, create a minimal one:
```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './docs/spec/<SPEC_NAME>/verification/ui',
  use: { baseURL: 'http://localhost:<UI_PORT>' },
});
```
Use the UI dev server port detected in Step 2.

**4c. Write and execute a Playwright test for each UI scenario:**

Create `docs/spec/<SPEC_NAME>/verification/ui/<scenario-id>.spec.ts`:
```ts
import { test, expect } from '@playwright/test';
test('<scenario description>', async ({ page }) => {
  // Step-by-step from scenario, with screenshot() calls at specified points
  await page.goto('/route');
  await page.screenshot({ path: 'docs/spec/<SPEC_NAME>/verification/ui/<scenario-id>-step1.png' });
  // ... fill, click, assert ...
  await page.screenshot({ path: 'docs/spec/<SPEC_NAME>/verification/ui/<scenario-id>-stepN.png' });
});
```

Execute:
```
npx playwright test docs/spec/<SPEC_NAME>/verification/ui/<scenario-id>.spec.ts 2>&1
```

**4d. Record:** For each scenario — result (PASSED/FAILED), screenshots captured, any assertion failures.

---

## Step 5 — Generate Proof Report

Generate `docs/spec/<SPEC_NAME>/verification/proof-report.md` following the
**Verification Report** format in `references/dashboard-report-formats.md`
(see orchestrate skill references).

Include:
- Summary table: scenario ID, type, description, verdict
- API evidence: curl commands and truncated responses
- UI evidence: embedded screenshot references
- DB evidence: queries and results
- Infrastructure note: what was started, when it was cleaned up

---

## Step 6 — Cleanup

1. Kill any background processes started in Step 2:
   ```
   kill %1 2>/dev/null  # npm dev server
   docker compose down 2>/dev/null  # docker services
   ```
2. Leave verification artifacts in `docs/spec/<SPEC_NAME>/verification/` —
   do NOT delete them. They will be committed by the orchestrator's Commit & PR stage.

---

## Token Efficiency Rules

- **Curl responses capped at 50 lines.** Use `head -50` if piping output.
- **Screenshots, not HTML dumps.** A PNG is smaller than page DOM in conversation.
- **Scenarios as a table in the proof report** — each row one line, not paragraph per scenario.
- **Don't re-read spec/plan/phase files** if the orchestrator already loaded them.
- **One `npx playwright install` check** — not per scenario.
- **DB queries use `--csv` or `-t` flags** for compact output (`psql -t -c '...'`).
- **Kill background processes before returning** — don't leak resources.
