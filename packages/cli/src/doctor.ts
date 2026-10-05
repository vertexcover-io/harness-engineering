import { Command } from "@commander-js/extra-typings";
import {
  buildNotifierCheck,
  type DoctorJson,
  type DoctorReport,
  type DoctorRow,
  findWorkflowPath,
  loadStartEnv,
  runDoctor,
  verdict,
  workflowChecks,
} from "@yok/core";
import { stopRunningOnSignal } from "@yok/sdk";
import { runtimeChecks } from "@yok/server";
import { cliLog, commandLog, compileOrFail } from "./client.ts";

const HEADERS = ["CHECK", "REQUIRED", "STATUS", "DETAIL", "FIX"] as const;
// A version banner (curl prints its whole TLS stack) would push the FIX column off-screen.
const MAX_DETAIL = 64;

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

const cells = (row: DoctorRow): readonly string[] => [
  row.name,
  row.optional ? "no" : "yes",
  row.status.toUpperCase(),
  truncate(row.detail, MAX_DETAIL),
  row.status === "ok" ? "-" : (row.fix[0] ?? "-"),
];

// One line per check. A fix with several steps wraps under the FIX column.
export const renderTable = (results: readonly DoctorRow[]): string => {
  const rows = results.map(cells);
  const widths = HEADERS.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (values: readonly string[]): string =>
    values
      .map((value, column) =>
        column === values.length - 1 ? value : value.padEnd(widths[column] ?? 0),
      )
      .join("  ")
      .trimEnd();
  const fixIndent = " ".repeat(widths.slice(0, -1).reduce((total, width) => total + width + 2, 0));
  const body = results.flatMap((result, index) => {
    const extraSteps = result.status === "ok" ? [] : result.fix.slice(1);
    return [line(rows[index] ?? []), ...extraSteps.map((step) => `${fixIndent}${step}`)];
  });
  return [line(HEADERS), ...body].join("\n");
};

const FAIL_ADVICE = "Fix the FAIL rows above.";
const WARN_ADVICE = "Every required check passed. Each WARN costs the one stage it unblocks.";

const advice = (report: DoctorReport): readonly string[] => {
  if (report.failed.length > 0) return [FAIL_ADVICE];
  if (report.warned.length > 0) return [WARN_ADVICE];
  return [];
};

export const renderText = (report: DoctorReport): string =>
  [
    "ENVIRONMENT",
    renderTable(report.results),
    "",
    "VERDICT",
    verdict(report),
    ...advice(report),
  ].join("\n");

export const renderJson = (report: DoctorReport): string => {
  const json: DoctorJson = { ...report, verdict: verdict(report) };
  return JSON.stringify(json, null, 2);
};

export const exitCodeFor = (report: DoctorReport): number => (report.failed.length > 0 ? 1 : 0);

// Without a workflow, the env a run would get from the .env and the config alone.
const declaredChecks = async (workflow: string | undefined) => {
  const cwd = process.cwd();
  if (workflow === undefined) {
    const env = await loadStartEnv(null, cwd, { env: {}, agent: "claude" });
    return [buildNotifierCheck(undefined, env)];
  }
  const plan = await compileOrFail(findWorkflowPath(workflow, cwd), cwd);
  if (plan === null) return null;
  const env = await loadStartEnv(null, cwd, plan);
  return [...workflowChecks(plan.doctor, env), buildNotifierCheck(plan.notifier, env)];
};

export const doctorCommand = () =>
  new Command("doctor")
    .description("Check the tools, repository and config a yok run needs")
    .option("--json", "print the report as JSON")
    .option("--workflow <name|path>", "also run the checks this workflow declares")
    .action(async ({ json, workflow }) => {
      stopRunningOnSignal();
      const declared = await declaredChecks(workflow);
      if (declared === null) return;
      const report = await runDoctor({
        cwd: process.cwd(),
        extraChecks: [...runtimeChecks("claude"), ...declared],
        log: cliLog(),
      });
      commandLog("doctor").debug(
        { verdict: verdict(report), failed: report.failed.length, warned: report.warned.length },
        "doctor finished",
      );
      console.log(json === true ? renderJson(report) : renderText(report));
      process.exitCode = exitCodeFor(report);
    });
