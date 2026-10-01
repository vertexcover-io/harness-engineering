import { describe, expect, test } from "bun:test";
import { expandPath, shellWriteTargets } from "./write-targets.ts";

const BASE = { cwd: "/repo", home: "/home/u", harnessHome: "/home/u/.harness" };
const targets = (command: string): readonly string[] => shellWriteTargets(command, BASE);
const S = "/repo/.harness/a/state.json";
const E = "/repo/.harness/a/event.jsonl";
const REGISTRY = "/home/u/.harness/registry.json";

describe("shellWriteTargets", () => {
  test("SC1 — redirections name their targets, and duplicating or reading does not", () => {
    expect(targets("echo x > .harness/a/state.json")).toEqual([S]);
    expect(targets("jq . f >> .harness/a/event.jsonl")).toEqual([E]);
    expect(targets("cmd 2>/tmp/err")).toEqual(["/tmp/err"]);
    expect(targets("cmd &> out.log")).toEqual(["/repo/out.log"]);
    expect(targets("printf x >notes.md")).toEqual(["/repo/notes.md"]);
    expect(targets("cmd 2>&1")).toEqual([]);
    expect(targets("cmd < .harness/a/state.json")).toEqual([]);
  });

  test("SC2 — writing commands name what they change, and copying from a record does not", () => {
    expect(targets("rm .harness/a/state.json")).toEqual([S]);
    expect(targets("mv /tmp/s .harness/a/state.json")).toContain(S);
    expect(targets("mv .harness/a/state.json /tmp/s")).toContain(S);
    expect(targets("tee -a .harness/a/event.jsonl")).toEqual([E]);
    expect(targets("sed -i '' 's/a/b/' .harness/a/state.json")).toEqual([S]);
    expect(targets("sed -i.bak -e 's/a/b/' .harness/a/state.json")).toEqual([S]);
    expect(targets("perl -pi -e 's/a/b/' x")).toEqual(["/repo/x"]);
    expect(targets("truncate -s0 y")).toEqual(["/repo/y"]);
    expect(targets("dd if=/dev/zero of=.harness/a/event.jsonl")).toEqual([E]);
    expect(targets("cp .harness/a/state.json /tmp/copy")).not.toContain(S);
    expect(targets("cp /tmp/copy .harness/a/state.json")).toContain(S);
    expect(targets("ln -sf /tmp/s .harness/a/state.json")).toContain(S);
  });

  test("editors without an in-place flag only read", () => {
    expect(targets("sed -n 1,5p .harness/a/state.json")).toEqual([]);
    expect(targets("perl -Mstrict -ne print .harness/a/state.json")).toEqual([]);
    expect(targets("ruby -Ilib -e 'puts 1' .harness/a/state.json")).toEqual([]);
  });

  test("copying or moving into a run folder writes the file of the same name there", () => {
    expect(targets("cp /tmp/state.json .harness/a/")).toContain(S);
    expect(targets("mv backup/event.jsonl .harness/a")).toContain(E);
    expect(targets("cp -r /tmp/state.json.bak .harness/a/")).not.toContain(S);
  });

  test("SC3 — inline interpreter code names only the paths its write calls take", () => {
    expect(targets(`python3 -c "open('.harness/a/state.json','w').write('{}')"`)).toEqual([S]);
    expect(targets(`node -e "require('fs').writeFileSync('.harness/a/state.json','{}')"`)).toEqual([
      S,
    ]);
    expect(
      targets(
        `python3 -c "from pathlib import Path; Path('.harness/a/state.json').write_text('{}')"`,
      ),
    ).toEqual([S]);
    expect(targets(`python3 -c "print(open('.harness/a/state.json').read())"`)).toEqual([]);
    expect(
      targets(
        `python3 -c "import json,os; d=json.load(open('.harness/a/state.json')); os.remove('/tmp/a')"`,
      ),
    ).toEqual(["/tmp/a"]);
    expect(
      targets(
        `python3 -c "json.dump(json.load(open('.harness/a/state.json')), open('/tmp/c','w'))"`,
      ),
    ).toEqual(["/tmp/c"]);
  });

  test("interpreter code fed through a heredoc is checked like inline code", () => {
    const write = ["python3 - <<'EOF'", "open('.harness/a/state.json','w').write('{}')", "EOF"];
    const read = ["node <<EOF", "require('fs').readFileSync('.harness/a/state.json')", "EOF"];
    expect(targets(write.join("\n"))).toEqual([S]);
    expect(targets(read.join("\n"))).toEqual([]);
  });

  test("SC4 — heredoc bodies and quoted text are data", () => {
    const heredoc = [
      "bun run orchestrate done n1 --run a --output - <<'JSON'",
      `{"note": "rm .harness/a/state.json"}`,
      "JSON",
    ].join("\n");
    expect(targets(heredoc)).toEqual([]);
    expect(targets(`echo "rm .harness/a/state.json"`)).toEqual([]);
    expect(targets(`git commit -m "fix > .harness/a/state.json"`)).toEqual([]);
  });

  test("comments are not commands, and an apostrophe in one hides nothing", () => {
    expect(targets("rm .harness/a/state.json # don't keep it")).toEqual([S]);
    expect(targets(`# reset the run's record\nrm .harness/a/state.json\necho "it's gone"`)).toEqual(
      [S],
    );
    expect(targets("echo hi # don't\nmv /tmp/s .harness/a/event.jsonl")).toContain(E);
    expect(targets("echo ok # see > .harness/a/state.json")).toEqual([]);
  });

  test("SC5 — wrappers, chains and cd are followed", () => {
    expect(targets("sudo rm .harness/a/state.json")).toEqual([S]);
    expect(targets("FOO=1 env -i rm x")).toEqual(["/repo/x"]);
    expect(targets("ls && rm .harness/a/event.jsonl")).toEqual([E]);
    expect(targets("cd .harness/a && rm state.json")).toEqual([S]);
    expect(targets("cd ~/.harness && rm registry.json")).toEqual([REGISTRY]);
    expect(targets("cd $HARNESS_HOME && rm registry.json")).toEqual([REGISTRY]);
  });

  test("home and harness-home spellings expand, and other variables are unknown", () => {
    for (const path of [
      "~/.harness/registry.json",
      "$HOME/.harness/registry.json",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell form under test
      "${HOME}/.harness/registry.json",
      "$HARNESS_HOME/registry.json",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell form under test
      "${HARNESS_HOME}/registry.json",
    ]) {
      expect(targets(`rm "${path}"`)).toEqual([REGISTRY]);
    }
    expect(targets("rm $OTHER/registry.json")).toEqual([]);
  });

  test("SC6 — an unclosed quote drops only the segment it is in", () => {
    expect(targets(`rm ".harness/a/state.json`)).toEqual([]);
    // bash will not run a segment with an unclosed quote, so its complete words are not targets either
    expect(targets(`rm .harness/a/state.json "oops`)).toEqual([]);
    expect(targets(`rm .harness/a/state.json; echo 'oops`)).toEqual([S]);
  });

  test("SC7 — the script of a shell -c or eval is scanned as a command", () => {
    expect(targets("bash -c 'rm .harness/a/state.json'")).toEqual([S]);
    expect(targets('sh -lc "mv /tmp/s .harness/a/event.jsonl"')).toContain(E);
    expect(targets('eval "rm .harness/a/state.json"')).toEqual([S]);
    expect(targets("bash -c 'cd .harness/a && rm state.json'")).toEqual([S]);
    expect(targets("bash -c \"bash -c 'rm .harness/a/state.json'\"")).toEqual([S]);
    expect(targets("bash -c 'cat .harness/a/state.json'")).toEqual([]);
    expect(targets("bash script.sh")).toEqual([]);
  });

  test("SC8 — nesting deeper than three levels is not followed", () => {
    const wrap = (script: string): string => `bash -c '${script.replaceAll("'", "'\\''")}'`;
    const nest = (levels: number): string =>
      Array.from({ length: levels }).reduce<string>((script) => wrap(script), "rm x");
    expect(targets(nest(3))).toEqual(["/repo/x"]);
    expect(targets(nest(4))).toEqual([]);
  });
});

describe("expandPath", () => {
  test("resolves against the working folder, and gives up on unknown variables", () => {
    expect(expandPath(".harness/a/state.json", BASE)).toBe(S);
    expect(expandPath("~", BASE)).toBe("/home/u");
    expect(expandPath("$UNSET/x", BASE)).toBeUndefined();
  });
});
