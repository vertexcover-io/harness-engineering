#!/usr/bin/env node
// After a simulated session: enable its dummy repo in the local (worktree) Samskara with an
// isolated CLI config, let the real watcher upload the transcript and the learn events, then check
// the rows and the evidence through the API. Usage: SAMSKARA_DIR=<samskara checkout> node
// samskara-check.mjs <resultDir>. The checkout's .env must point at its own database; the dev user
// `samskara-dev` must exist (bun run seed).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const W = process.env.SAMSKARA_DIR;
if (!W) {
  console.error("set SAMSKARA_DIR to a samskara checkout (a worktree with its own database is best)");
  process.exit(2);
}
const resultDir = process.argv[2];
const result = JSON.parse(readFileSync(join(resultDir, "result.json"), "utf8"));
const envFile = Object.fromEntries(
  readFileSync(join(W, ".env"), "utf8").split("\n").filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1)];
  }),
);
const api = `http://localhost:${envFile.PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const healthy = async () => fetch(`${api}/api/health`).then((res) => res.ok, () => false);

const ensureServer = async () => {
  if (await healthy()) return;
  const log = openSync(join(tmpdir(), "learn-sim-server.log"), "a");
  spawn("npx", ["tsx", "--env-file=../../.env", "src/index.ts"], {
    cwd: join(W, "packages/server"),
    detached: true,
    stdio: ["ignore", log, log],
    // The server refuses to boot without the AI reviewer's key; reviews are not exercised here.
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN || "local-e2e-unused" },
  }).unref();
  for (let i = 0; i < 60 && !(await healthy()); i += 1) await sleep(1000);
  if (!(await healthy())) throw new Error("local samskara server did not start");
};

// Tokens for the seeded dev user: a cli one for the watcher, a web one to read the API.
const mintTokens = (home) => {
  const script = `
import postgres from "postgres"
import { signToken } from "${W}/packages/server/src/lib/jwt.ts"
import { storeToken } from "${W}/packages/cli/src/config/credentials.ts"
const sql = postgres(process.env.DATABASE_URL)
const [u] = await sql\`select id from users where "githubLogin" = 'samskara-dev'\`
await sql.end()
const config = { jwtSecret: process.env.JWT_SECRET, jwtExpiresIn: "1h" }
await storeToken(await signToken(config, { sub: u.id, aud: "cli" }))
console.log(await signToken(config, { sub: u.id, aud: "web" }))
`;
  const out = spawnSync("bun", ["-e", script], {
    cwd: join(W, "packages/server"),
    env: { ...process.env, SAMSKARA_HOME: home, DATABASE_URL: envFile.DATABASE_URL, JWT_SECRET: envFile.JWT_SECRET },
    encoding: "utf8",
  });
  if (out.status !== 0) throw new Error(`token mint failed: ${out.stderr}`);
  return out.stdout.trim().split("\n").pop();
};

const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });

await ensureServer();
const home = mkdtempSync(join(tmpdir(), "learn-sim-samskara-home-"));
const webToken = mintTokens(home);
const cliEnv = { ...process.env, SAMSKARA_HOME: home, SAMSKARA_API_URL: api };
const enable = spawnSync("bun", ["packages/cli/src/index.ts", "enable", "--all", result.repo], { cwd: W, env: cliEnv, encoding: "utf8" });
check("repo enabled in samskara", enable.status === 0, (enable.stdout + enable.stderr).trim().split("\n").pop());

const get = (path) =>
  fetch(`${api}/api/compound-learnings${path}`, { headers: { cookie: `session=${webToken}` } }).then((res) => res.json());

// The watcher uploads transcripts and learn events on its own cycle; wait for both to land.
const wanted = new Set(result.events.map((event) => event.event_id));
let rows = [];
let details = [];
for (let i = 0; i < 90; i += 1) {
  rows = ((await get("")).events ?? []).filter((row) => wanted.has(row.eventId));
  details = await Promise.all(rows.map((row) => get(`/${row.id}`)));
  const settled = rows.length === wanted.size && details.every((detail) => !detail.event?.evidenceToMessage || detail.evidence?.length > 0);
  if (settled) break;
  await sleep(2000);
}

const pid = existsSync(join(home, "watch.pid")) ? Number(readFileSync(join(home, "watch.pid"), "utf8")) : null;
if (pid) {
  try {
    process.kill(pid);
  } catch {}
}

check(`every local event is a row (${wanted.size})`, rows.length === wanted.size, `${rows.length} row(s)`);
for (const detail of details) {
  const local = result.events.find((event) => event.event_id === detail.event?.eventId);
  const label = `${local?.outcome}/${local?.status}`;
  check(`${label}: fields match the jsonl`, detail.event?.outcome === local?.outcome && (detail.event?.status ?? "") === (local?.status ?? "") && detail.event?.skillVersion === local?.skill_version);
  check(`${label}: linked to its session's project`, detail.event?.projectId !== null, detail.event?.projectName ?? "no project");
  if (local?.evidence_to_message) {
    // The detail returns the evidence range and the messages in it; both ends must be among them.
    const lines = (detail.evidence ?? []).map((message) => message.lineNumber);
    const range = detail.evidenceRange;
    check(
      `${label}: evidence messages cover the exchange`,
      range !== null && lines.includes(range.first) && lines.includes(range.last),
      `${lines.length} message(s), range ${JSON.stringify(range)}`,
    );
  }
}
if (wanted.size === 0) check("nothing to upload (no events expected)", rows.length === 0);

const samskara = { passed: checks.every((entry) => entry.pass), checks, rows: details };
writeFileSync(join(resultDir, "samskara.json"), `${JSON.stringify(samskara, null, 2)}\n`);
console.log(`samskara home: ${home}`);
console.log(`samskara: ${samskara.passed ? "PASS" : "FAIL"}`);
for (const entry of checks) console.log(`  ${entry.pass ? "✓" : "✗"} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
