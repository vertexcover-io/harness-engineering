import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type NodeRun,
  parseJson,
  type RunRef,
  readState,
  runDirOf,
  type State,
} from "@harness/sdk";
import { parse } from "yaml";
import * as z from "zod";

const BAR_CELLS = 10;
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

// Claude sends `used_percentage: null` early in a session, so every field is nullish.
const StatuslineInputSchema = z.looseObject({
  model: z.looseObject({ display_name: z.string().nullish() }).nullish(),
  context_window: z.looseObject({ used_percentage: z.number().nullish() }).nullish(),
});
type StatuslineInput = z.infer<typeof StatuslineInputSchema>;

const WorkflowNodeSchema = z.looseObject({
  id: z.string(),
  stage: z.string().optional(),
  nodes: z.array(z.unknown()).optional(),
});
const WorkflowSchema = z.looseObject({ nodes: z.array(z.unknown()) });

type Workflow = Readonly<{ total: number; stages: ReadonlyMap<string, string> }>;

const paint = (color: string, text: string): string => `${color}${text}${RESET}`;

const parseInput = (stdin: string): StatuslineInput => {
  const json = parseJson(stdin);
  const parsed = StatuslineInputSchema.safeParse(json.ok ? json.value : {});
  return parsed.success ? parsed.data : {};
};

const stagesOf = (nodes: readonly unknown[], parents: readonly string[]): [string, string][] =>
  nodes.flatMap((raw) => {
    const node = WorkflowNodeSchema.safeParse(raw);
    if (!node.success) return [];
    const path = [...parents, node.data.id];
    return [
      ...(node.data.stage === undefined
        ? []
        : [[path.join("/"), node.data.stage] as [string, string]]),
      ...stagesOf(node.data.nodes ?? [], path),
    ];
  });

const readWorkflow = async (runDir: string): Promise<Workflow | null> => {
  const text = await readFile(join(runDir, "workflow.yaml"), "utf8").catch(() => null);
  if (text === null) return null;
  const parsed = WorkflowSchema.safeParse(parse(text));
  if (!parsed.success) return null;
  return { total: parsed.data.nodes.length, stages: new Map(stagesOf(parsed.data.nodes, [])) };
};

type Running = Readonly<{ path: readonly string[]; run: NodeRun }>;

const runningEntry = (nodes: Readonly<Record<string, NodeRun>>): [string, NodeRun] | undefined =>
  Object.entries(nodes).find(([, run]) => run.status === "running");

const deepestRunning = (
  nodes: Readonly<Record<string, NodeRun>>,
  parents: readonly string[] = [],
): Running | undefined => {
  const entry = runningEntry(nodes);
  if (entry === undefined) return undefined;
  const [id, run] = entry;
  const path = [...parents, id];
  return (run.nodes && deepestRunning(run.nodes, path)) || { path, run };
};

const nodeLabel = ({ path, run }: Running, workflow: Workflow | null): string => {
  const id = path.at(-1);
  const stage = run.stage ?? workflow?.stages.get(path.join("/"));
  const ids = path.map((part, index) =>
    index === path.length - 1 && run.iteration !== undefined ? `${part} #${run.iteration}` : part,
  );
  const label = ids.join(" › ");
  return stage === undefined || stage === id ? label : `${label} (stage ${stage})`;
};

const progressBar = (done: number, total: number): string => {
  const filled = Math.min(BAR_CELLS, Math.round((done / total) * BAR_CELLS));
  return `[${"▓".repeat(filled)}${"░".repeat(BAR_CELLS - filled)}] ${done}/${total}`;
};

const elapsed = (startedAt: string, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
};

const FINISHED: Readonly<Record<string, string>> = {
  completed: paint(GREEN, "✓ completed"),
  failed: paint(RED, "✗ failed"),
  cancelled: paint(RED, "✗ cancelled"),
};

const runPart = (
  state: State,
  running: Running | undefined,
  workflow: Workflow | null,
): string[] => {
  const finished = FINISHED[state.status];
  if (finished !== undefined) return [`▸ ${finished}`];
  if (running === undefined) return [];
  return [`▸ ${paint(GREEN, nodeLabel(running, workflow))}`];
};

const trailing = (
  state: State,
  running: Running | undefined,
  input: StatuslineInput,
  now: number,
): string[] => {
  const showElapsed = state.status === "running" && running?.run.startedAt;
  const percentage = input.context_window?.used_percentage;
  return [
    ...(showElapsed ? [elapsed(showElapsed, now)] : []),
    ...(input.model?.display_name ? [input.model.display_name] : []),
    ...(percentage == null ? [] : [`ctx ${Math.round(percentage)}%`]),
  ];
};

const readStateOrNull = (runDir: string): Promise<State | null> =>
  readState(runDir).catch(() => null);

// The line Claude Code shows for a harness run session. Reads the run's saved state without a
// lock and never writes; the caller prints it.
export const renderStatusline = async (stdin: string, run: RunRef | undefined): Promise<string> => {
  if (run === undefined) return "harness · starting";
  const runDir = runDirOf(run.cwd, run.name);
  const [state, workflow] = await Promise.all([
    readStateOrNull(runDir),
    readWorkflow(runDir).catch(() => null),
  ]);
  const head = `harness ${run.name}`;
  if (state === null) return head;
  const now = Date.now();
  const running = deepestRunning(state.nodeRuns);
  const done = Object.values(state.nodeRuns).filter((node) => node.status !== "running").length;
  const total = workflow?.total ?? 0;
  const progress = total === 0 ? [] : [progressBar(done, total)];
  const first = [head, ...runPart(state, running, workflow), ...progress].join(" ");
  return [first, ...trailing(state, running, parseInput(stdin), now)].join(" · ");
};
