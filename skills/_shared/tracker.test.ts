import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  LIFECYCLE_STATES,
  createAsana,
  createGithub,
  createJira,
  createLinear,
  loadTrackerConfig,
  main,
  parseArgs,
  performVerb,
  resolveProvider,
  resolveTicketRef,
  runDoctor,
} from "./tracker.ts";
import type { Ticket, TrackerConfig, TrackerProvider, Verb } from "./tracker.ts";

type Call = ReadonlyArray<unknown>;

const TICKET: Ticket = {
  ref: "REF-12",
  url: "https://tracker.example/REF-12",
  title: "Login flow",
  body: "As a user…",
  state: "todo",
  labels: [],
};

const fake = (over: Partial<TrackerProvider> = {}, calls: Call[] = []): TrackerProvider => ({
  name: "fake",
  capabilities: new Set<Verb>(["get", "comment", "transition"]),
  get: async (ref) => {
    calls.push(["get", ref]);
    return TICKET;
  },
  comments: async (ref) => {
    calls.push(["comments", ref]);
    return [];
  },
  comment: async (ref, body) => {
    calls.push(["comment", ref, body]);
    return { ok: true, detail: "" };
  },
  transition: async (ref, state) => {
    calls.push(["transition", ref, state]);
    return { ok: true, detail: "" };
  },
  link: async (ref, url, title) => {
    calls.push(["link", ref, url, title]);
    return { ok: true, detail: "" };
  },
  attach: async (ref, file, name) => {
    calls.push(["attach", ref, file, name]);
    return { ok: true, detail: "" };
  },
  ...over,
});

const cfg = (over: Partial<TrackerConfig> = {}): TrackerConfig => ({
  provider: "fake",
  pattern: "REF-\\d+",
  states: { in_review: "Code Review" },
  on: {},
  secrets: {},
  repoRoot: "",
  ...over,
});

describe("parseArgs", () => {
  test("rejects an unknown verb", () => {
    assert.throws(() => parseArgs(["destroy"]), /Unknown verb/);
  });

  test("parses comment flags and --dry-run", () => {
    const args = parseArgs(["comment", "--body", "hi", "--marker", "m1", "--dry-run"]);
    assert.equal(args.verb, "comment");
    assert.equal(args.body, "hi");
    assert.equal(args.marker, "m1");
    assert.equal(args.dryRun, true);
  });

  test("reads --body-file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tracker-body-"));
    writeFileSync(join(dir, "b.md"), "from file");
    assert.equal(parseArgs(["comment", "--body-file", join(dir, "b.md")]).body, "from file");
    rmSync(dir, { recursive: true, force: true });
  });

  test("comment without a body is a usage error", () => {
    assert.throws(() => parseArgs(["comment"]), /--body/);
  });

  test("transition validates --to against the lifecycle vocabulary", () => {
    assert.throws(() => parseArgs(["transition", "--to", "Code Review"]), new RegExp(LIFECYCLE_STATES.join(", ")));
    assert.throws(() => parseArgs(["transition"]), /--to/);
    assert.equal(parseArgs(["transition", "--to", "in_review"]).to, "in_review");
  });

  test("link requires --url", () => {
    assert.throws(() => parseArgs(["link"]), /--url/);
  });

  test("attach requires --file", () => {
    assert.throws(() => parseArgs(["attach"]), /--file/);
    assert.equal(parseArgs(["attach", "--file", "a.zip"]).file, "a.zip");
  });

  test("event takes a positional name and repeatable --var KEY=VALUE", () => {
    const args = parseArgs(["event", "pr-created", "--var", "PR_URL=https://pr/1", "--var", "SPEC=my-spec"]);
    assert.equal(args.verb, "event");
    assert.equal(args.event, "pr-created");
    assert.deepEqual(args.vars, { PR_URL: "https://pr/1", SPEC: "my-spec" });
    assert.throws(() => parseArgs(["event"]), /event needs a name/);
    assert.throws(() => parseArgs(["event", "--var", "A=1"]), /event needs a name/);
  });
});

describe("resolveTicketRef", () => {
  test("explicit ref wins, else first pattern match on the branch", () => {
    assert.equal(resolveTicketRef("REF-9", "REF-\\d+", "main"), "REF-9");
    assert.equal(resolveTicketRef(null, "REF-\\d+", "feature/REF-12-login"), "REF-12");
    assert.equal(resolveTicketRef(null, "REF-\\d+", "main"), null);
  });

  test("no pattern and no explicit ref is an error", () => {
    assert.throws(() => resolveTicketRef(null, null, "main"), /pattern/);
  });
});

describe("performVerb", () => {
  test("resolve prints the ref; a miss exits 1", async () => {
    const hit = await performVerb(parseArgs(["resolve"]), cfg(), fake(), "feature/REF-12-login");
    assert.deepEqual(hit, { lines: ["REF-12"], code: 0 });
    const miss = await performVerb(parseArgs(["resolve"]), cfg(), fake(), "main");
    assert.equal(miss.code, 1);
  });

  test("get prints ticket JSON; a provider failure exits 1", async () => {
    const ok = await performVerb(parseArgs(["get"]), cfg(), fake(), "REF-12");
    assert.equal(ok.code, 0);
    assert.equal((JSON.parse(ok.lines.join("\n")) as Ticket).ref, "REF-12");

    const bad = fake({ get: async () => { throw new Error("boom"); } });
    const fail = await performVerb(parseArgs(["get"]), cfg(), bad, "REF-12");
    assert.equal(fail.code, 1);
    assert.match(fail.lines[0] ?? "", /boom/);
  });

  test("a write on a branch with no ticket ref skips with exit 0", async () => {
    const calls: Call[] = [];
    const out = await performVerb(parseArgs(["comment", "--body", "hi"]), cfg(), fake({}, calls), "main");
    assert.equal(out.code, 0);
    assert.equal(calls.length, 0);
    assert.match(out.lines[0] ?? "", /no ticket ref/);
  });

  test("comment stamps the marker and posts", async () => {
    const calls: Call[] = [];
    const out = await performVerb(
      parseArgs(["comment", "--body", "hi", "--marker", "m1"]),
      cfg(),
      fake({}, calls),
      "REF-12",
    );
    assert.equal(out.code, 0);
    const posted = calls.find((c) => c[0] === "comment");
    assert.match(String(posted?.[2]), /<!-- m1 -->/);
  });

  test("comment with a marker already on the ticket is skipped", async () => {
    const calls: Call[] = [];
    const seen = fake({ comments: async () => ["earlier\n<!-- m1 -->"] }, calls);
    const out = await performVerb(
      parseArgs(["comment", "--body", "hi", "--marker", "m1"]),
      cfg(),
      seen,
      "REF-12",
    );
    assert.equal(out.code, 0);
    assert.match(out.lines[0] ?? "", /already/);
    assert.equal(calls.some((c) => c[0] === "comment"), false);
  });

  test("--dry-run calls no provider method", async () => {
    const calls: Call[] = [];
    const out = await performVerb(
      parseArgs(["comment", "--body", "hi", "--dry-run"]),
      cfg(),
      fake({}, calls),
      "REF-12",
    );
    assert.equal(calls.length, 0);
    assert.match(out.lines[0] ?? "", /^DRY-RUN/);
  });

  test("an unsupported verb degrades in one line, exit 0", async () => {
    const limited = fake({ capabilities: new Set<Verb>(["get"]) });
    const out = await performVerb(parseArgs(["comment", "--body", "hi"]), cfg(), limited, "REF-12");
    assert.equal(out.code, 0);
    assert.match(out.lines[0] ?? "", /does not support comment/);
  });

  test("transition maps the lifecycle state to the project's own name", async () => {
    const calls: Call[] = [];
    await performVerb(parseArgs(["transition", "--to", "in_review"]), cfg(), fake({}, calls), "REF-12");
    assert.deepEqual(calls, [["transition", "REF-12", "Code Review"]]);
  });

  test("an unmapped lifecycle state never moves the ticket", async () => {
    const calls: Call[] = [];
    const out = await performVerb(parseArgs(["transition", "--to", "blocked"]), cfg(), fake({}, calls), "REF-12");
    assert.equal(out.code, 0);
    assert.equal(calls.length, 0);
    assert.match(out.lines[0] ?? "", /not moved/);
  });

  test("a provider that cannot reach the state reports why, exit 0", async () => {
    const stuck = fake({ transition: async () => ({ ok: false, detail: "no legal transition" }) });
    const out = await performVerb(parseArgs(["transition", "--to", "in_review"]), cfg(), stuck, "REF-12");
    assert.equal(out.code, 0);
    assert.match(out.lines[0] ?? "", /no legal transition/);
  });

  test("link falls back to an idempotent comment when the provider has no native link", async () => {
    const calls: Call[] = [];
    const out = await performVerb(parseArgs(["link", "--url", "https://pr/1"]), cfg(), fake({}, calls), "REF-12");
    assert.equal(out.code, 0);
    const posted = calls.find((c) => c[0] === "comment");
    assert.match(String(posted?.[2]), /harness:link:https:\/\/pr\/1/);

    const again: Call[] = [];
    const seen = fake({ comments: async () => ["<!-- harness:link:https://pr/1 -->"] }, again);
    await performVerb(parseArgs(["link", "--url", "https://pr/1"]), cfg(), seen, "REF-12");
    assert.equal(again.some((c) => c[0] === "comment"), false);
  });

  test("link uses the provider's native link when it has one", async () => {
    const calls: Call[] = [];
    const native = fake({ capabilities: new Set<Verb>(["link"]) }, calls);
    await performVerb(
      parseArgs(["link", "--url", "https://pr/1", "--title", "PR #1"]),
      cfg(),
      native,
      "REF-12",
    );
    assert.deepEqual(calls, [["link", "REF-12", "https://pr/1", "PR #1"]]);
  });

  test("attach passes the file and defaults the name to its basename", async () => {
    const calls: Call[] = [];
    const withAttach = fake({ capabilities: new Set<Verb>(["attach"]) }, calls);
    const out = await performVerb(
      parseArgs(["attach", "--file", "/tmp/bundles/spec.zip"]),
      cfg(),
      withAttach,
      "REF-12",
    );
    assert.equal(out.code, 0);
    assert.deepEqual(calls, [["attach", "REF-12", "/tmp/bundles/spec.zip", "spec.zip"]]);
  });

  test("attach on a provider without the capability skips, exit 0", async () => {
    const calls: Call[] = [];
    const out = await performVerb(
      parseArgs(["attach", "--file", "a.zip"]),
      cfg(),
      fake({}, calls),
      "REF-12",
    );
    assert.equal(out.code, 0);
    assert.equal(calls.length, 0);
    assert.match(out.lines[0] ?? "", /does not support attach/);
  });

  test("a write-verb provider crash is soft: one line, exit 0", async () => {
    const bad = fake({ comment: async () => { throw new Error("503 from tracker"); } });
    const out = await performVerb(parseArgs(["comment", "--body", "hi"]), cfg(), bad, "REF-12");
    assert.equal(out.code, 0);
    assert.match(out.lines[0] ?? "", /503 from tracker/);
  });
});

describe("performVerb event", () => {
  test("an event with no bindings skips in one line, exit 0", async () => {
    const out = await performVerb(parseArgs(["event", "pr-created"]), cfg(), fake(), "REF-12");
    assert.equal(out.code, 0);
    assert.match(out.lines[0] ?? "", /no actions bound/);
  });

  test("actions run in order with {VAR}, {TICKET} and {BRANCH} substituted", async () => {
    const calls: Call[] = [];
    const bound = cfg({
      on: {
        "pr-created": [
          { link: "{PR_URL}" },
          { transition: "in_review" },
          { comment: "PR for {TICKET} on {BRANCH}: {PR_URL}" },
        ],
      },
    });
    const out = await performVerb(
      parseArgs(["event", "pr-created", "--var", "PR_URL=https://pr/1"]),
      bound,
      fake({}, calls),
      "feature/REF-12-login",
    );
    assert.equal(out.code, 0);
    assert.equal(out.lines.length, 3);
    // link has no native capability on the fake → falls back to a marked comment
    const [linkComment, transition, comment] = calls.filter((c) => c[0] === "comment" || c[0] === "transition");
    assert.match(String(linkComment?.[2]), /https:\/\/pr\/1/);
    assert.deepEqual(transition, ["transition", "REF-12", "Code Review"]);
    assert.match(String(comment?.[2]), /PR for REF-12 on feature\/REF-12-login: https:\/\/pr\/1/);
  });

  test("comment actions are idempotent per event (and per SPEC when given)", async () => {
    const calls: Call[] = [];
    const seen = fake({ comments: async () => ["<!-- harness:verified:my-spec -->"] }, calls);
    const bound = cfg({ on: { verified: [{ comment: "done" }] } });
    await performVerb(parseArgs(["event", "verified", "--var", "SPEC=my-spec"]), bound, seen, "REF-12");
    assert.equal(calls.some((c) => c[0] === "comment"), false);
  });

  test("comment_file reads a repo-relative template; a missing file is one line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tracker-tpl-"));
    writeFileSync(join(dir, "tpl.md"), "verified {TICKET}");
    const calls: Call[] = [];
    const bound = cfg({ repoRoot: dir, on: { verified: [{ comment_file: "tpl.md" }, { comment_file: "gone.md" }] } });
    const out = await performVerb(parseArgs(["event", "verified"]), bound, fake({}, calls), "REF-12");
    const posted = calls.find((c) => c[0] === "comment");
    assert.match(String(posted?.[2]), /verified REF-12/);
    assert.match(out.lines[1] ?? "", /gone\.md/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unknown action key warns and continues; a bad transition target warns", async () => {
    const calls: Call[] = [];
    const bound = cfg({
      on: { verified: [{ frobnicate: "x" }, { transition: "Not A Lifecycle" }, { comment: "still ran" }] },
    });
    const out = await performVerb(parseArgs(["event", "verified"]), bound, fake({}, calls), "REF-12");
    assert.equal(out.code, 0);
    assert.match(out.lines[0] ?? "", /unknown event action/);
    assert.match(out.lines[1] ?? "", /not a lifecycle state/);
    assert.equal(calls.some((c) => c[0] === "comment"), true);
  });

  test("a run action substitutes vars and executes", async () => {
    const bound = cfg({ on: { verified: [{ run: "echo ran-for-{TICKET}" }] } });
    const out = await performVerb(parseArgs(["event", "verified"]), bound, fake(), "REF-12");
    assert.match(out.lines[0] ?? "", /ran-for-REF-12/);
  });

  test("--dry-run walks every action without touching the provider", async () => {
    const calls: Call[] = [];
    const bound = cfg({ on: { verified: [{ transition: "in_review" }, { comment: "hi" }, { run: "echo x" }] } });
    const out = await performVerb(parseArgs(["event", "verified", "--dry-run"]), bound, fake({}, calls), "REF-12");
    assert.equal(calls.length, 0);
    assert.equal(out.lines.every((line) => line.startsWith("DRY-RUN")), true);
  });
});

describe("runDoctor", () => {
  test("a healthy config with a reachable ticket is all OK, exit 0", async () => {
    const out = await runDoctor(cfg(), "feature/REF-12-login", null, fake());
    assert.equal(out.code, 0);
    assert.match(out.lines.join("\n"), /ticket REF-12/);
    assert.equal(out.lines.some((line) => line.startsWith("FAIL")), false);
  });

  test("an unknown provider is a FAIL, exit 1", async () => {
    const out = await runDoctor(cfg({ provider: "trello" }), "main", null, null);
    assert.equal(out.code, 1);
    assert.match(out.lines.join("\n"), /trello/);
  });

  test("a pattern that does not compile is a FAIL, exit 1", async () => {
    const out = await runDoctor(cfg({ pattern: "REF-[" }), "main", null, fake());
    assert.equal(out.code, 1);
    assert.match(out.lines.join("\n"), /pattern/);
  });

  test("non-lifecycle states keys and unknown actions are WARNs, exit 0", async () => {
    const bound = cfg({
      states: { in_review: "Code Review", review: "oops" },
      on: { "pr-created": [{ frobnicate: "x" }, { transition: "not_a_state" }] },
    });
    const out = await runDoctor(bound, "feature/REF-12-x", null, fake());
    assert.equal(out.code, 0);
    const text = out.lines.join("\n");
    assert.match(text, /WARN.*"review"/);
    assert.match(text, /WARN.*frobnicate/);
    assert.match(text, /WARN.*not_a_state/);
  });

  test("a get that fails against a real ref is a FAIL", async () => {
    const dead = fake({ get: async () => { throw new Error("401"); } });
    const out = await runDoctor(cfg(), "feature/REF-12-x", null, dead);
    assert.equal(out.code, 1);
    assert.match(out.lines.join("\n"), /401/);
  });

  test("no resolvable ref is a WARN, not a failure", async () => {
    const out = await runDoctor(cfg(), "main", null, fake());
    assert.equal(out.code, 0);
    assert.match(out.lines.join("\n"), /WARN.*--ref/);
  });
});

const repoFixture = (config: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), "tracker-repo-"));
  execFileSync("git", ["init", "-q", "-b", "feature/REF-12-login", dir]);
  writeFileSync(join(dir, "orchestrate.config.json"), JSON.stringify(config));
  return dir;
};

describe("loadTrackerConfig", () => {
  test("returns null when the config has no tracker block", () => {
    const dir = repoFixture({ commands: {} });
    assert.equal(loadTrackerConfig(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads provider, pattern, states and event bindings", () => {
    const dir = repoFixture({
      tracker: {
        provider: "github",
        resolve: { from: "branch", pattern: "REF-\\d+" },
        states: { done: "closed" },
        on: { "pr-created": [{ link: "{PR_URL}" }] },
      },
    });
    const got = loadTrackerConfig(dir);
    assert.equal(got?.provider, "github");
    assert.equal(got?.pattern, "REF-\\d+");
    assert.deepEqual(got?.states, { done: "closed" });
    assert.deepEqual(got?.on, { "pr-created": [{ link: "{PR_URL}" }] });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("resolveProvider", () => {
  test("rejects an unknown provider naming the supported ones", () => {
    assert.throws(() => resolveProvider(cfg({ provider: "trello" })), /github/);
  });
});

describe("createGithub", () => {
  const gh = (responses: Record<string, string>, log: string[][] = []): TrackerProvider =>
    createGithub((args) => {
      log.push([...args]);
      return responses[args.slice(0, 3).join(" ")] ?? "";
    });

  test("get parses gh issue view output", async () => {
    const log: string[][] = [];
    const provider = gh(
      {
        "issue view 12": JSON.stringify({
          number: 12,
          title: "T",
          body: "B",
          state: "OPEN",
          url: "https://github.com/o/r/issues/12",
          labels: [{ name: "bug" }],
        }),
      },
      log,
    );
    const ticket = await provider.get("#12");
    assert.deepEqual(ticket, {
      ref: "#12",
      title: "T",
      body: "B",
      state: "open",
      url: "https://github.com/o/r/issues/12",
      labels: ["bug"],
    });
    assert.deepEqual(log[0]?.slice(0, 3), ["issue", "view", "12"]);
  });

  test("comments returns comment bodies", async () => {
    const provider = gh({ "issue view 12": JSON.stringify({ comments: [{ body: "a" }, { body: "b" }] }) });
    assert.deepEqual(await provider.comments("12"), ["a", "b"]);
  });

  test("transition reaches only open and closed", async () => {
    const log: string[][] = [];
    const provider = gh({}, log);
    assert.equal((await provider.transition("12", "closed")).ok, true);
    assert.equal((await provider.transition("12", "open")).ok, true);
    const other = await provider.transition("12", "Code Review");
    assert.equal(other.ok, false);
    assert.match(other.detail, /Code Review/);
    assert.deepEqual(log.map((l) => l.slice(0, 2)), [["issue", "close"], ["issue", "reopen"]]);
  });
});

describe("createAsana", () => {
  type Route = { readonly body: unknown };
  type Hit = { readonly url: string; readonly method: string };

  const asana = (routes: Record<string, Route>, hits: Hit[] = []) =>
    createAsana({ ASANA_PAT: "pat", ASANA_WORKSPACE_GID: "ws1" }, async (url, init) => {
      hits.push({ url, method: init?.method ?? "GET" });
      const match = Object.entries(routes).find(([part]) => url.includes(part));
      return {
        ok: match !== undefined,
        status: match === undefined ? 404 : 200,
        json: async () => match?.[1].body ?? {},
      };
    });

  const SEARCH = { body: { data: [{ gid: "42", name: "REF-12 · Login flow" }] } };

  test("a missing credential names the exact key", () => {
    assert.throws(() => createAsana({}, async () => ({ ok: true, status: 200, json: async () => ({}) })), /ASANA_PAT/);
    assert.throws(
      () => createAsana({ ASANA_PAT: "pat" }, async () => ({ ok: true, status: 200, json: async () => ({}) })),
      /ASANA_WORKSPACE_GID/,
    );
  });

  test("get searches the workspace for the ref, then fetches the task", async () => {
    const hits: Hit[] = [];
    const provider = asana(
      {
        "tasks/search": SEARCH,
        "tasks/42?": {
          body: { data: { name: "REF-12 · Login flow", notes: "the notes", completed: false, permalink_url: "https://app.asana.com/t/42" } },
        },
      },
      hits,
    );
    const ticket = await provider.get("REF-12");
    assert.equal(ticket.title, "REF-12 · Login flow");
    assert.equal(ticket.body, "the notes");
    assert.equal(ticket.state, "open");
    assert.equal(ticket.url, "https://app.asana.com/t/42");
    assert.match(hits[0]?.url ?? "", /workspaces\/ws1\/tasks\/search\?text=REF-12/);
  });

  test("a ref with no matching task is an error naming the ref", async () => {
    const provider = asana({ "tasks/search": { body: { data: [{ gid: "9", name: "unrelated" }] } } });
    await assert.rejects(() => provider.get("REF-12"), /REF-12/);
  });

  test("comment posts a story; comments returns only comment stories", async () => {
    const hits: Hit[] = [];
    const provider = asana(
      {
        "tasks/search": SEARCH,
        "tasks/42/stories": {
          body: { data: [{ type: "comment", text: "hello" }, { type: "system", text: "moved" }] },
        },
      },
      hits,
    );
    assert.deepEqual(await provider.comments("REF-12"), ["hello"]);
    assert.equal((await provider.comment("REF-12", "hi")).ok, true);
    assert.equal(hits.filter((h) => h.url.includes("/stories") && h.method === "POST").length, 1);
  });

  test("attach posts the file to the attachments endpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tracker-attach-"));
    writeFileSync(join(dir, "spec.zip"), "zipbytes");
    const hits: Hit[] = [];
    const provider = asana({ "tasks/search": SEARCH, "attachments": { body: { data: {} } } }, hits);
    const result = await provider.attach("REF-12", join(dir, "spec.zip"), "spec.zip");
    assert.equal(result.ok, true);
    assert.equal(hits.filter((h) => h.url.endsWith("/attachments") && h.method === "POST").length, 1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("declares no transition capability, so states degrade cleanly", () => {
    const provider = asana({});
    assert.equal(provider.capabilities.has("transition"), false);
    assert.equal(provider.capabilities.has("attach"), true);
  });
});

describe("createLinear", () => {
  type GqlHit = { readonly query: string; readonly variables: Record<string, unknown> };

  // Routes keyed by a substring of the GraphQL query; the fake answers whichever matches.
  const linear = (routes: Record<string, unknown>, hits: GqlHit[] = []) =>
    createLinear({ LINEAR_API_KEY: "lin_key" }, async (_url, init) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as GqlHit;
      hits.push(payload);
      const match = Object.entries(routes).find(([part]) => payload.query.includes(part));
      return { ok: true, status: 200, json: async () => ({ data: match?.[1] ?? {} }) };
    });

  // A full GraphQL data payload: the fake returns route values as `data` verbatim.
  const SEARCH_DATA = {
    issueSearch: {
      nodes: [
        { id: "uuid-1", identifier: "ENG-123", title: "T", description: "D", url: "https://linear.app/i/ENG-123", state: { name: "Todo" } },
        { id: "uuid-2", identifier: "ENG-1234", title: "other", description: "", url: "u", state: { name: "Todo" } },
      ],
    },
  };

  test("a missing credential names LINEAR_API_KEY", () => {
    assert.throws(() => createLinear({}, async () => ({ ok: true, status: 200, json: async () => ({}) })), /LINEAR_API_KEY/);
  });

  test("get matches the identifier exactly, not the first search hit", async () => {
    const provider = linear({ issueSearch: SEARCH_DATA });
    const ticket = await provider.get("ENG-123");
    assert.equal(ticket.ref, "ENG-123");
    assert.equal(ticket.title, "T");
    assert.equal(ticket.state, "todo");
  });

  test("transition resolves the target state name to the team's stateId", async () => {
    const hits: GqlHit[] = [];
    const provider = linear(
      {
        issueSearch: SEARCH_DATA,
        "team {": { issue: { team: { states: { nodes: [{ id: "st-1", name: "In Review" }, { id: "st-2", name: "Done" }] } } } },
        issueUpdate: { issueUpdate: { success: true } },
      },
      hits,
    );
    const result = await provider.transition("ENG-123", "In Review");
    assert.equal(result.ok, true);
    const update = hits.find((h) => h.query.includes("issueUpdate"));
    assert.equal((update?.variables ?? {})["stateId"], "st-1");
  });

  test("a state name the team lacks reports the names it has", async () => {
    const provider = linear({
      issueSearch: SEARCH_DATA,
      "team {": { issue: { team: { states: { nodes: [{ id: "st-2", name: "Done" }] } } } },
    });
    const result = await provider.transition("ENG-123", "Code Review");
    assert.equal(result.ok, false);
    assert.match(result.detail, /Done/);
  });

  test("link is native: attachmentLinkURL", async () => {
    const hits: GqlHit[] = [];
    const provider = linear(
      { issueSearch: SEARCH_DATA, attachmentLinkURL: { attachmentLinkURL: { success: true } } },
      hits,
    );
    assert.equal((await provider.link("ENG-123", "https://pr/1", "PR #1")).ok, true);
    assert.equal(provider.capabilities.has("link"), true);
    const link = hits.find((h) => h.query.includes("attachmentLinkURL"));
    assert.equal((link?.variables ?? {})["url"], "https://pr/1");
  });
});

describe("createJira", () => {
  type Hit = { readonly url: string; readonly method: string; readonly body: string };

  const jira = (routes: Record<string, unknown>, hits: Hit[] = []) =>
    createJira(
      { JIRA_BASE_URL: "https://acme.atlassian.net/", JIRA_EMAIL: "e@x.io", JIRA_API_TOKEN: "tok" },
      async (url, init) => {
        hits.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
        const match = Object.entries(routes).find(([part]) => url.includes(part));
        return { ok: match !== undefined, status: match === undefined ? 404 : 200, json: async () => match?.[1] ?? {} };
      },
    );

  test("missing credentials name the exact key", () => {
    const noop = async () => ({ ok: true, status: 200, json: async () => ({}) });
    assert.throws(() => createJira({}, noop), /JIRA_BASE_URL/);
    assert.throws(() => createJira({ JIRA_BASE_URL: "u" }, noop), /JIRA_EMAIL/);
    assert.throws(() => createJira({ JIRA_BASE_URL: "u", JIRA_EMAIL: "e" }, noop), /JIRA_API_TOKEN/);
  });

  test("get reads the issue and builds the browse url off the trimmed base", async () => {
    const provider = jira({
      "issue/REF-12?": { fields: { summary: "T", description: "D", status: { name: "To Do" }, labels: ["infra"] } },
    });
    const ticket = await provider.get("REF-12");
    assert.equal(ticket.title, "T");
    assert.equal(ticket.state, "to do");
    assert.equal(ticket.url, "https://acme.atlassian.net/browse/REF-12");
    assert.deepEqual(ticket.labels, ["infra"]);
  });

  test("transition picks the legal transition whose target matches, by name", async () => {
    const hits: Hit[] = [];
    const provider = jira(
      { "/transitions": { transitions: [{ id: "31", to: { name: "In Review" } }, { id: "41", to: { name: "Done" } }] } },
      hits,
    );
    assert.equal((await provider.transition("REF-12", "in review")).ok, true);
    const posted = hits.find((h) => h.method === "POST");
    assert.match(posted?.body ?? "", /"31"/);
  });

  test("no legal transition to the target reports the reachable ones", async () => {
    const provider = jira({ "/transitions": { transitions: [{ id: "41", to: { name: "Done" } }] } });
    const result = await provider.transition("REF-12", "In Review");
    assert.equal(result.ok, false);
    assert.match(result.detail, /Done/);
  });

  test("link posts a remote link and comment posts a body", async () => {
    const hits: Hit[] = [];
    const provider = jira({ "/remotelink": {}, "/comment": {} }, hits);
    assert.equal((await provider.link("REF-12", "https://pr/1", "PR #1")).ok, true);
    assert.equal((await provider.comment("REF-12", "hi")).ok, true);
    assert.deepEqual(hits.map((h) => h.method), ["POST", "POST"]);
  });
});

describe("main", () => {
  test("resolves the ticket from the branch and posts through the provider", async () => {
    const dir = repoFixture({ tracker: { provider: "github", resolve: { pattern: "REF-\\d+" } } });
    const calls: Call[] = [];
    const code = await main(["comment", "--body", "hi"], fake({}, calls), dir);
    assert.equal(code, 0);
    assert.deepEqual(calls, [["comment", "REF-12", "hi"]]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("without a tracker block a write skips with exit 0", async () => {
    const dir = repoFixture({});
    assert.equal(await main(["comment", "--body", "hi"], null, dir), 0);
    rmSync(dir, { recursive: true, force: true });
  });
});
