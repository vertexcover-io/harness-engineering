import * as z from "zod";

export const CheckStatusSchema = z.enum(["ok", "warn", "fail"]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export type ExecResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};
// Rejects when the command outlives the runner's time limit.
export type Exec = (command: string, args: readonly string[], cwd: string) => Promise<ExecResult>;

export type Outcome = {
  readonly status: CheckStatus;
  readonly detail: string;
  readonly fix?: readonly string[] | undefined;
};

// config: the file `harness run --config` named, read in place of the repo's own config.
export type CheckContext = {
  readonly root: string;
  readonly exec: Exec;
  readonly config?: string | undefined;
};

export type Check = {
  readonly name: string;
  // Optional checks report but never fail the run; the stage they unblock degrades instead.
  readonly optional?: boolean;
  readonly fix: readonly string[];
  readonly run: (context: CheckContext) => Promise<Outcome>;
};

export const ok = (detail: string): Outcome => ({ status: "ok", detail });
export const warn = (detail: string, fix?: readonly string[]): Outcome => ({
  status: "warn",
  detail,
  fix,
});
export const fail = (detail: string, fix?: readonly string[]): Outcome => ({
  status: "fail",
  detail,
  fix,
});

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

// A tool is present when its version command exits 0; the first line of output is the detail.
export const checkBinary =
  (binary: string, versionArgs: readonly string[] = ["--version"]) =>
  async ({ root, exec }: CheckContext): Promise<Outcome> => {
    const { code, stdout } = await exec(binary, versionArgs, root);
    return code === 0 ? ok(firstLine(stdout)) : fail("not on PATH");
  };
