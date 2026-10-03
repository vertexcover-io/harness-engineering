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

const CODE = [
  "# Code",
  "",
  "1. Change the schema:",
  "",
  "   ```diff",
  "   -const old = 1;",
  `   +const replacement = "${"a long line that has to wrap inside the box ".repeat(6)}";`,
  "   ```",
  "",
  "> A note from the planner.",
  "",
  "| Requirement | Level | Strategy | Phase |",
  "|---|---|---|---|",
  "| R1 config hooks load and are validated (SC101, SC102, SC103) | unit | `loadConfig` on YAML text, data-driven bad blocks | 1 |",
  "| R3 failing hooks become failed calls (SC104) | unit | `callHook` over throw, missing module, exit code, two timeouts | 1 |",
  "| R2 return value becomes output (SC105) | unit | `callHook` with temp modules and `sh -c` commands | 1 |",
  "| R4 which hooks an event gets (SC106) | unit | `hooksFor` on hand-built states and events | 1 |",
  "| R6 notifier block and reserved name (SC201, SC202) | unit | `loadConfig` | 2 |",
  "| R7, R8 messages per moment (SC203, SC204, SC205) | unit | `noticeOf` and `slackText`, table-driven | 2 |",
  "| R7 Slack client (SC206) | unit | fake `fetch` recording requests | 2 |",
  "| R9 missing variables (SC207, SC208) | unit | temp `.env`; `compileWorkflow` on a temp workflow | 2 |",
  "| R7 thread reuse, uploads, nothing to post (SC210, SC212, SC217) | unit | `notify` with a fake opener | 2 |",
  "| R10 question parsing (SC301) | unit | `parsePreToolUseInput` with Claude-shaped JSON | 3 |",
  "| R12 answer parsing (SC307) | unit | PostToolUse parse on a payload captured from Claude Code (phase 3 step 1) | 3 |",
  "| R10, R11, R12 messages (SC302) | unit | `noticeOf` | 3 |",
  "| R10, R11, R12 Claude settings (SC303) | unit | `claudeSettings` hooks block | 3 |",
  "| R5 init freezes hooks (SC107, SC108, SC109) | integration | `initializeRun` in a temp git repo, as `runs.test.ts` does | 1 |",
  "| R2, R4 blocking hooks recorded before the append returns (SC110) | integration | `appendRunEvent` on a run built with `createState` | 1 |",
  "| R4 a repeated event id runs nothing (SC111) | integration | same run, same id | 1 |",
  "| R3 a failure does not stop the others (SC112) | integration | a throwing hook first | 1 |",
  "| R4 non-blocking runs detached (SC113) | integration | a sleeping command hook, timed append | 1 |",
  "| R4 one hook's detached calls never overlap (SC114) | integration | start/end markers in a file | 1 |",
  "| R4 a hook may store events (SC115) | integration | a module hook calling `emitRunEvent` | 1 |",
  "| R6 notifier frozen, workflow wins (SC209) | integration | `initializeRun` | 2 |",
  "| R7 the first thread lands in state (SC211) | integration | call records appended to a temp run | 2 |",
  "| R3, R9 notifier with no secrets (SC213) | integration | real frozen notifier hook through init and the detached runner, empty env | 2 |",
  "| R9 doctor row (SC214) | integration | `runDoctor` in a temp repo | 2 |",
  "| R10, R12 question and answer recorded and linked (SC304, SC305) | integration | Claude PreToolUse and PostToolUse adapters, temp registry and run | 3 |",
  "| R11 agent stop recorded (SC306) | integration | Claude StopFailure adapter | 3 |",
  "| R1, R4 a real run fires a config hook (SC116) | e2e | orchestrate script as processes | 1 |",
  "",
  "```ts",
  ...Array.from({ length: 50 }, (_, i) => `const line${i + 1} = ${i + 1};`),
  "```",
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
    writeFileSync(join(runDir, "artifacts", "code.md"), CODE);
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
      tier: null,
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

  test("a code block is one wrapped box with diff colors, not a stack of inline chips", async () => {
    browser("set", "viewport", "1000", "800");
    browser("open", `${url}#artifacts/code.md`);
    await until("!!document.querySelector('#docRoot pre .hljs-addition')");
    const look = evaluate(`(() => {
      const pre = document.querySelector('#docRoot pre');
      const style = (sel) => getComputedStyle(document.querySelector(sel));
      return {
        boxed: style('#docRoot pre').backgroundColor !== 'rgba(0, 0, 0, 0)',
        chip: style('#docRoot pre code').backgroundColor,
        wraps: pre.scrollWidth <= pre.clientWidth,
        diffColored: style('#docRoot .hljs-addition').backgroundColor !== style('#docRoot .hljs-deletion').backgroundColor,
        quoteRule: style('#docRoot blockquote').borderLeftStyle,
        hangs: (() => {
          const line = [...document.querySelectorAll('#docRoot .hljs-addition')].find((l) => l.textContent.includes('long line'));
          const range = document.createRange();
          range.selectNodeContents(line);
          const lefts = new Map();
          for (const r of range.getClientRects()) lefts.set(Math.round(r.top), Math.min(lefts.get(Math.round(r.top)) ?? Infinity, r.left));
          const [first, second] = [...lefts.values()];
          return lefts.size > 1 && second > first;
        })(),
        cellWordWhole: [...document.querySelectorAll('#docRoot td')].every((td) => {
          const text = td.firstChild;
          if (text?.nodeType !== Node.TEXT_NODE) return true;
          const word = text.data.split(/\\s/)[0];
          const range = document.createRange();
          range.setStart(text, 0);
          range.setEnd(text, word.length);
          return range.getClientRects().length <= 1;
        }),
      };
    })()`);
    expect(look).toEqual({
      boxed: true,
      chip: "rgba(0, 0, 0, 0)",
      wraps: true,
      diffColored: true,
      quoteRule: "solid",
      hangs: true,
      cellWordWhole: true,
    });
  }, 30000);
});
