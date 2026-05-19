# Infra startup

## Probe common ports

```bash
for p in 3000 3001 8080 8000 5173 4200; do
  curl -s -o /dev/null -w "$p:%{http_code}\n" http://localhost:$p
done
```

Proceed with whatever responds.

## Start a service

If a required service isn't up, find a startup command in:

- `package.json` → `scripts.dev` / `start` / `start:api`
- `docker-compose.yml` / `compose.yml`
- `Makefile` → `up` / `start` / `dev`

Run in background:

```bash
npm run dev &> /tmp/functional-verify.log &
# or
docker compose up -d --wait
```

## Health-poll up to 30s

```bash
for i in $(seq 1 30); do
  curl -s -o /dev/null http://localhost:<PORT> && break
  sleep 1
done
```

## Cleanup contract

If you started a process here, you kill it in Step 7 (`kill %1`, `docker compose down`). If a process was already running when you arrived, leave it alone and note that in the proof report under "Infrastructure."
