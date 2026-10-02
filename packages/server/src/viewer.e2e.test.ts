import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowRun } from "@harness/sdk";
import { noopLogger } from "@harness/sdk";
import { createRegistry } from "@harness/sdk/internal";
import { stopDeliveries } from "./delivery.ts";
import { claudeOver, EMPTY_BOX, fakeHost } from "./fake-host.ts";
import { startViewer, type Viewer } from "./viewer.ts";

const ORCHESTRATE = join(import.meta.dir, "..", "..", "core", "src", "orchestrate.ts");
const SESSION = `viewer-e2e-${process.pid}`;

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "harness-viewer-e2e-")));

const DESIGN = [
  "# Design",
  "",
  "## Approach",
  "",
  "Keep one file per run so the page stays simple. A second sentence follows here.",
  "",
].join("\n");

const MOCKUP = `<!doctype html><html><body>
<div class="mk-card"><h2 class="mk-title">Sign in</h2><button id="go">Loading</button></div>
<script>document.getElementById("go").textContent = "Continue";</script>
</body></html>`;

const browser = (...args: string[]): string => {
  const run = spawnSync("agent-browser", args, {
    encoding: "utf8",
    env: { ...process.env, AGENT_BROWSER_SESSION: SESSION },
  });
  if (run.status !== 0)
    throw new Error(`agent-browser ${args[0]} failed: ${run.stderr}${run.stdout}`);
  return run.stdout.trim();
};

const evaluate = (js: string): unknown => {
  const out = browser("eval", js);
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
};

const until = async (js: string, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (evaluate(js) === true) return;
    await Bun.sleep(100);
  }
  throw new Error(`still false after ${ms}ms: ${js}`);
};

const selectText = (inFrame: boolean, text: string): void => {
  const doc = inFrame ? "document.querySelector('#htmlFrame').contentDocument" : "document";
  const root = inFrame ? `${doc}.body` : "document.querySelector('#docRoot')";
  evaluate(`(() => {
    const doc = ${doc}; const root = ${root};
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.data.indexOf(${JSON.stringify(text)});
      if (at === -1) continue;
      const range = doc.createRange();
      range.setStart(n, at); range.setEnd(n, at + ${text.length});
      const sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      return true;
    }
    return false;
  })()`);
};

const barShown = "!document.querySelector('#selbar').hidden";

describe("viewer in a browser", () => {
  let home: string;
  let cwd: string;
  let runDir: string;
  let viewer: Viewer;
  let url: string;

  beforeAll(async () => {
    home = tempDir();
    cwd = tempDir();
    execFileSync("git", ["init", "-q"], { cwd });
    runDir = join(cwd, ".harness", "demo");
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    writeFileSync(join(runDir, "artifacts", "design.md"), DESIGN);
    writeFileSync(join(runDir, "artifacts", "mock.html"), MOCKUP);
    const registry = createRegistry(join(home, "registry.json"), noopLogger);
    const run: WorkflowRun = {
      id: "r1",
      workflow: "w",
      workflowPath: "/w.yaml",
      inputs: {},
      cwd,
      sessions: [{ agent: "claude", sessionId: "s1" }],
      name: "demo",
      terminal: "s1",
      config: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await registry.addRun(run);
    const { host } = fakeHost(EMPTY_BOX);
    viewer = await startViewer({
      home,
      registry,
      providerFor: () => claudeOver(host),
      host,
      log: noopLogger,
    });
    url = `${viewer.origin}/runs/r1`;
  });

  afterAll(async () => {
    stopDeliveries();
    spawnSync("agent-browser", ["close"], {
      env: { ...process.env, AGENT_BROWSER_SESSION: SESSION },
    });
    await viewer.stop();
  });

  test("SC33: Comment mode gates the selection bar, and a sent comment reaches the agent's status", async () => {
    browser("open", `${url}#artifacts/design.md`);
    await until("!!document.querySelector('#docRoot')");
    evaluate("localStorage.setItem('harness-viewer:comment-mode','off')");
    browser("reload");
    await until("!!document.querySelector('#docRoot')");

    selectText(false, "one file per run");
    await Bun.sleep(600);
    expect(evaluate(barShown)).toBe(false);

    browser("click", "#modeBtn");
    selectText(false, "one file per run");
    await until(barShown);

    browser("click", "#selbar button[data-kind=comment]");
    browser("fill", "#composerText", "Why only one file?");
    browser("press", "Control+Enter");
    await until("document.querySelector('.batch') !== null");
    expect(evaluate("document.querySelector('#docRoot mark.hl.is-draft') !== null")).toBe(true);
    expect(evaluate("document.querySelector('.batch .group-label').textContent")).toContain(
      "Not sent yet",
    );

    browser("click", "#sendBtn");
    await until("document.querySelector('.batch') === null");
    await until(
      "[...document.querySelectorAll('#threads .card .status')].some((s) => s.textContent === 'With the agent')",
      5000,
    );
  }, 60000);

  test("SC34: a reply and an edit by the agent appear without a reload", async () => {
    const reply = spawnSync(
      "bun",
      [
        ORCHESTRATE,
        "comments",
        "reply",
        "--run",
        "demo",
        "--id",
        "c1",
        "--status",
        "answered",
        "--text",
        "Simpler to review.",
      ],
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, HARNESS_RUN_ID: undefined, HARNESS_HOME: home },
      },
    );
    expect(reply.status).toBe(0);
    await until(
      "document.querySelector('#threads .card').textContent.includes('Simpler to review.') && document.querySelector('#threads .card .status').textContent === 'Answered'",
      3500,
    );

    writeFileSync(
      join(runDir, "artifacts", "design.md"),
      DESIGN.replace("Keep one file per run so the page stays simple. ", ""),
    );
    await until(
      "document.querySelector('#toast').textContent === 'design.md changed' && !document.querySelector('#toast').hidden",
      3500,
    );
    await until(
      "[...document.querySelectorAll('#threads .group-label')].some((l) => l.textContent === 'Text no longer in the file')",
      3500,
    );
    expect(readFileSync(join(runDir, "comments.json"), "utf8")).toContain("Simpler to review.");
  }, 30000);

  test("SC35: text selected inside an HTML artifact becomes a comment with an element path", async () => {
    browser("open", `${url}#artifacts/mock.html`);
    await until(
      "document.querySelector('#htmlFrame')?.contentDocument?.getElementById('go')?.textContent === 'Continue'",
    );
    selectText(true, "Sign in");
    await until(barShown);
    browser("click", "#selbar button[data-kind=comment]");
    browser("fill", "#composerText", "Make the title bolder");
    browser("press", "Control+Enter");
    await until("document.querySelector('.batch') !== null");
    browser("click", "#sendBtn");
    await until("document.querySelector('.batch') === null");
    await until(
      "[...document.querySelectorAll('#threads .loc')].some((l) => l.textContent.includes('div.mk-card > h2.mk-title'))",
    );
  }, 30000);
});
