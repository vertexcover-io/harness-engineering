#!/usr/bin/env node
// Port of dag-update.sh. Manages .harness/<SPEC_NAME>/dag.json with atomic,
// lock-protected writes. Usage: dag-update.mjs <command> [args...]

import { createReadStream, readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, platform } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BREADCRUMB = join(tmpdir(), ".claude-harness-active");

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const die = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};

// ── Atomic write with mkdir-based spinlock ───────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const withLock = async (dagFile, mutate) => {
  const lockDir = join(dirname(dagFile), "dag.lock.d");
  let acquired = false;
  for (let i = 0; i < 50; i++) {
    try {
      mkdirSync(lockDir);
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      await sleep(100);
    }
  }
  if (!acquired) {
    try { spawnSync("rm", ["-rf", lockDir]); } catch {}
    try { mkdirSync(lockDir); } catch {}
  }
  try {
    const current = JSON.parse(readFileSync(dagFile, "utf8"));
    const next = (await mutate(current)) ?? current;
    const tmp = `${dagFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    spawnSync("mv", [tmp, dagFile]);
  } finally {
    try { spawnSync("rm", ["-rf", lockDir]); } catch {}
  }
};

const dagPath = () => {
  const dir = process.env.HARNESS_DIR;
  if (!dir) die("HARNESS_DIR must be set");
  return join(dir, "dag.json");
};

// ── Commands ─────────────────────────────────────────────────────────────────

const cmdInit = async (specName, task, branch = "unknown", worktree = "unknown") => {
  if (!specName || !task) die("Usage: init <spec_name> <task> [branch] [worktree]");

  const harnessDir = join(process.cwd(), ".harness", specName);

  // Crash recovery
  const oldPidFile = join(harnessDir, "server.pid");
  if (existsSync(oldPidFile)) {
    const oldPid = parseInt(readFileSync(oldPidFile, "utf8").trim(), 10);
    let alive = false;
    if (Number.isFinite(oldPid)) {
      try { process.kill(oldPid, 0); alive = true; } catch {}
    }
    if (!alive) {
      process.env.HARNESS_DIR = harnessDir;
      await cmdFinalize("interrupted");
    }
  }

  mkdirSync(join(harnessDir, "reports"), { recursive: true });

  const dag = {
    meta: {
      specName,
      task,
      branch,
      worktree,
      startedAt: nowIso(),
      completedAt: null,
      outcome: "running",
    },
    nodes: {},
    edges: [],
  };
  writeFileSync(join(harnessDir, "dag.json"), JSON.stringify(dag, null, 2));
  writeFileSync(BREADCRUMB, harnessDir);
  process.stdout.write(`${harnessDir}\n`);
};

const parseFlags = (argv) => {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      flags[a.slice(2)] = argv[++i];
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
};

const cmdAddNode = async (...args) => {
  const { flags, positional } = parseFlags(args);
  const [nodeId, label] = positional;
  if (!nodeId || !label) die("Usage: add-node <id> <label> [--parent X] [--depends-on a,b]");

  await withLock(dagPath(), (dag) => {
    dag.nodes[nodeId] = {
      label,
      status: "pending",
      startedAt: null,
      completedAt: null,
      artifacts: {},
      children: [],
    };
    if (flags.parent) {
      const p = dag.nodes[flags.parent];
      if (p) p.children = [...(p.children || []), nodeId];
    }
    return dag;
  });

  if (flags["depends-on"]) {
    const deps = flags["depends-on"].split(",").map((s) => s.trim()).filter(Boolean);
    for (const dep of deps) {
      await withLock(dagPath(), (dag) => {
        dag.edges = [...(dag.edges || []), [dep, nodeId]];
        return dag;
      });
    }
  }
};

const cmdAddEdge = async (from, to) => {
  if (!from || !to) die("Usage: add-edge <from> <to>");
  await withLock(dagPath(), (dag) => {
    dag.edges = [...(dag.edges || []), [from, to]];
    return dag;
  });
};

const cmdSetStatus = async (nodeId, status) => {
  if (!nodeId || !status) die("Usage: set-status <node-id> <status>");
  const now = nowIso();
  await withLock(dagPath(), (dag) => {
    const node = dag.nodes[nodeId];
    if (!node) return dag;
    node.status = status;
    if (status === "running" || status === "waiting") node.startedAt = now;
    if (["done", "failed", "interrupted", "skipped"].includes(status)) node.completedAt = now;
    return dag;
  });
};

const cmdSetArtifact = async (nodeId, key, value) => {
  if (!nodeId || !key) die("Usage: set-artifact <node-id> <key> <value>");
  await withLock(dagPath(), (dag) => {
    const node = dag.nodes[nodeId];
    if (!node) return dag;
    node.artifacts = node.artifacts || {};
    node.artifacts[key] = value ?? "";
    return dag;
  });
};

const cmdWriteReport = async (nodeId, content) => {
  if (!nodeId) die("Usage: write-report <node-id> <content>");
  const harnessDir = process.env.HARNESS_DIR;
  if (!harnessDir) die("HARNESS_DIR must be set");
  const rel = `reports/${nodeId}-report.md`;
  writeFileSync(join(harnessDir, rel), content ?? "");
  await cmdSetArtifact(nodeId, "report", rel);
};

const cmdServe = async () => {
  const harnessDir = process.env.HARNESS_DIR;
  if (!harnessDir) die("HARNESS_DIR must be set");

  copyFileSync(join(SCRIPT_DIR, "index.html"), join(harnessDir, "index.html"));

  const mime = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".css": "text/css",
    ".js": "application/javascript",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  };

  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const abs = resolve(harnessDir, rel);
    if (!abs.startsWith(resolve(harnessDir))) {
      res.statusCode = 403; res.end("Forbidden"); return;
    }
    if (!existsSync(abs) || statSync(abs).isDirectory()) {
      res.statusCode = 404; res.end("Not found"); return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", mime[extname(abs)] || "application/octet-stream");
    createReadStream(abs).pipe(res);
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  writeFileSync(join(harnessDir, "server.pid"), String(process.pid));
  writeFileSync(join(harnessDir, "server.port"), String(port));

  const url = `http://localhost:${port}`;
  const opener =
    platform === "darwin" ? ["open", [url]] :
    platform === "win32" ? ["cmd", ["/c", "start", "", url]] :
    ["xdg-open", [url]];
  try {
    const c = spawn(opener[0], opener[1], { stdio: "ignore", detached: true });
    c.unref(); c.on("error", () => {});
  } catch {}

  process.stdout.write(`${url}\n`);
  // Detach: server keeps running after this process exits. To match bash
  // behavior (which backgrounds python3), we let Node keep the event loop alive
  // — orchestrate is expected to kill via server.pid in finalize.
};

const inlineDataIntoHtml = (htmlPath, dagFile, harnessDir) => {
  const html = readFileSync(htmlPath, "utf8");
  const dag = readFileSync(dagFile, "utf8");

  const dagObj = JSON.parse(dag);
  const reports = {};
  for (const nodeId of Object.keys(dagObj.nodes || {})) {
    const rel = dagObj.nodes[nodeId]?.artifacts?.report;
    if (!rel) continue;
    const resolved = rel.startsWith("/") ? rel : join(harnessDir, rel);
    if (!existsSync(resolved)) continue;
    reports[nodeId] = readFileSync(resolved, "utf8");
  }

  const safe = (s) => s.replace(/<\/script>/g, "<\\/script>");
  const inject = (re, payload) =>
    re.test(html) ? html.replace(re, `$1${safe(payload)}$3`) : html;

  let out = html;
  out = inject(
    /(<script type="application\/json" id="dag-data">)([\s\S]*?)(<\/script>)/,
    dag,
  );
  // Re-read out for the second pass.
  const out2 = out.replace(
    /(<script type="application\/json" id="reports-data">)([\s\S]*?)(<\/script>)/,
    `$1${safe(JSON.stringify(reports))}$3`,
  );
  writeFileSync(htmlPath, out2);
};

const cmdFinalize = async (outcome = "interrupted") => {
  let harnessDir = process.env.HARNESS_DIR;
  if (!harnessDir) {
    // Find any active run
    const candidates = [];
    try {
      const root = join(process.cwd(), ".harness");
      if (existsSync(root)) {
        for (const d of readdirSync(root, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const f = join(root, d.name, "dag.json");
          if (existsSync(f) && readFileSync(f, "utf8").includes('"outcome": "running"')) {
            candidates.push(join(root, d.name));
          }
        }
      }
    } catch {}
    if (candidates.length === 0) process.exit(0);
    harnessDir = candidates[0];
    process.env.HARNESS_DIR = harnessDir;
  }

  const dagFile = join(harnessDir, "dag.json");
  if (!existsSync(dagFile)) process.exit(0);

  const current = JSON.parse(readFileSync(dagFile, "utf8"));
  if (current.meta?.outcome !== "running") process.exit(0);

  const now = nowIso();
  await withLock(dagFile, (dag) => {
    dag.meta.outcome = outcome;
    dag.meta.completedAt = now;
    for (const id of Object.keys(dag.nodes || {})) {
      const n = dag.nodes[id];
      if (n.status === "running") { n.status = outcome; n.completedAt = now; }
    }
    return dag;
  });

  const htmlPath = join(harnessDir, "index.html");
  if (existsSync(htmlPath)) inlineDataIntoHtml(htmlPath, dagFile, harnessDir);

  const pidFile = join(harnessDir, "server.pid");
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isFinite(pid)) { try { process.kill(pid); } catch {} }
    try { unlinkSync(pidFile); } catch {}
    try { unlinkSync(join(harnessDir, "server.port")); } catch {}
  }

  try { unlinkSync(BREADCRUMB); } catch {}
};

// ── Dispatch ─────────────────────────────────────────────────────────────────
const [, , sub, ...rest] = process.argv;
const dispatch = {
  init: cmdInit,
  "add-node": cmdAddNode,
  "add-edge": cmdAddEdge,
  "set-status": cmdSetStatus,
  "set-artifact": cmdSetArtifact,
  "write-report": cmdWriteReport,
  serve: cmdServe,
  finalize: cmdFinalize,
};

const handler = dispatch[sub];
if (!handler) {
  die(
    "Usage: dag-update.mjs <init|add-node|add-edge|set-status|set-artifact|write-report|serve|finalize> [args...]",
  );
}

try {
  await handler(...rest);
} catch (e) {
  die(`ERROR: ${e?.message || e}`);
}
