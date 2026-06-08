# Infra startup

Goal: get a live app on a **known** port fast, or fail fast with a clear reason. Never guess a port and hope; never let a missing service turn into a multi-minute hang.

The commands below are **illustrative (one common stack)** — derive the real ones from the project. The procedure is what transfers.

## 1. Is something already up? (probe, don't assume)

Probe the few ports the project's config/scripts mention, with a short per-probe timeout so a dead port fails in ~2s instead of waiting out a TCP timeout. Use whatever responds.

```bash
# example
for p in 3000 5173 8080; do curl -s -o /dev/null -w "$p:%{http_code}\n" --max-time 2 http://localhost:$p; done
```

## 2. Nothing up? Start it — and capture the ACTUAL port

Decide *how* from the repo, preferring in order:

1. **A self-provisioning command** — if the project's e2e/dev tooling starts its own services on its own ports (the hermetic pattern, `testing/references/hermetic-e2e.md`), run that and read the port it prints. Nothing else to manage.
2. **The project's own start mechanism** (a `dev`/`start` script, compose, a Makefile target), started on a port **you** allocate from a free one and pass via the env var/flag the app actually reads — don't fight whatever else is bound to the default.

```bash
# example: allocate a free port, start on it, capture it
PORT=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
PORT=$PORT <project's start command> &> /tmp/functional-verify.log &
echo "started app on $PORT"
```

Record the real port in `observations.md` under "Infrastructure"; every later curl/navigate uses it. Never type a port from memory — it drifts (config and compose often disagree).

## 3. Health-poll with a hard deadline (fail fast)

Find the readiness signal (a health route, or the service's own readiness probe) and poll it with a deadline. On miss, **stop and surface the log** — do not keep retrying or drive a browser against a dead app (that is what produces 120s+ selector timeouts that read as "stuck").

```bash
# example
for i in $(seq 1 30); do
  curl -s -o /dev/null --max-time 2 http://localhost:$PORT/health && { echo "up after ${i}s"; break; }
  [ "$i" = 30 ] && { echo "BLOCKED: app not healthy on :$PORT in 30s"; tail -40 /tmp/functional-verify.log; exit 1; }
  sleep 1
done
```

## 4. Database access / seeding

Prefer the project's own seed/migrate/fixtures tooling over hand-rolled writes — a malformed hand seed makes the real route fail and sends you debugging the wrong layer; validate any seed against the route's actual schema. Read the connection string from config; never hardcode the port.

In symlinked/monorepo layouts a one-off script's bare driver import may not resolve (e.g. "module not found"). Resolve it through the project's tooling, or from the package that declares the driver dependency.

```bash
# example (Node/pnpm worktree): resolve the driver from a package that depends on it
node --input-type=module -e "
import { createRequire } from 'module';
const require = createRequire('$(pwd)/<pkg-that-has-the-driver>/');
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DBURL, connectionTimeoutMillis: 5000 });
await c.connect(); /* seed/inspect */ await c.end();
" DBURL="$(grep -hoE 'postgresql://[^\"'\'' ]+' .env .env.* 2>/dev/null | head -1)"
```

## 5. Cleanup contract

If **you** started a process here, **you** stop it in Step 7 (`kill %1`; self-provisioning commands tear down their own infra). If a process was already running when you arrived, leave it alone and note that in the proof report under "Infrastructure."
