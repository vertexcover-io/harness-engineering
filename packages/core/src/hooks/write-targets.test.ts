import { describe, expect, test } from "bun:test";
import { expandPath, shellWriteTargets } from "./write-targets.ts";

const BASE = { cwd: "/repo", home: "/home/u", yokHome: "/home/u/.yok" };
const targets = (command: string): readonly string[] => shellWriteTargets(command, BASE);
const S = "/repo/.yok/a/state.json";
const E = "/repo/.yok/a/event.jsonl";
const REGISTRY = "/home/u/.yok/registry.json";

describe("shellWriteTargets", () => {
  test("SC1 — redirections name their targets, and duplicating or reading does not", () => {
    expect(targets("echo x > .yok/a/state.json")).toEqual([S]);
    expect(targets("jq . f >> .yok/a/event.jsonl")).toEqual([E]);
    expect(targets("cmd 2>/tmp/err")).toEqual(["/tmp/err"]);
    expect(targets("cmd &> out.log")).toEqual(["/repo/out.log"]);
    expect(targets("printf x >notes.md")).toEqual(["/repo/notes.md"]);
    expect(targets("cmd 2>&1")).toEqual([]);
    expect(targets("cmd < .yok/a/state.json")).toEqual([]);
  });

  test("SC2 — writing commands name what they change, and copying from a record does not", () => {
    expect(targets("rm .yok/a/state.json")).toEqual([S]);
    expect(targets("mv /tmp/s .yok/a/state.json")).toContain(S);
    expect(targets("mv .yok/a/state.json /tmp/s")).toContain(S);
    expect(targets("tee -a .yok/a/event.jsonl")).toEqual([E]);
    expect(targets("sed -i '' 's/a/b/' .yok/a/state.json")).toEqual([S]);
    expect(targets("sed -i.bak -e 's/a/b/' .yok/a/state.json")).toEqual([S]);
    expect(targets("perl -pi -e 's/a/b/' x")).toEqual(["/repo/x"]);
    expect(targets("truncate -s0 y")).toEqual(["/repo/y"]);
    expect(targets("dd if=/dev/zero of=.yok/a/event.jsonl")).toEqual([E]);
    expect(targets("cp .yok/a/state.json /tmp/copy")).not.toContain(S);
    expect(targets("cp /tmp/copy .yok/a/state.json")).toContain(S);
    expect(targets("ln -sf /tmp/s .yok/a/state.json")).toContain(S);
  });

  test("editors without an in-place flag only read", () => {
    expect(targets("sed -n 1,5p .yok/a/state.json")).toEqual([]);
    expect(targets("perl -Mstrict -ne print .yok/a/state.json")).toEqual([]);
    expect(targets("ruby -Ilib -e 'puts 1' .yok/a/state.json")).toEqual([]);
  });

  test("copying or moving into a run folder writes the file of the same name there", () => {
    expect(targets("cp /tmp/state.json .yok/a/")).toContain(S);
    expect(targets("mv backup/event.jsonl .yok/a")).toContain(E);
    expect(targets("cp -r /tmp/state.json.bak .yok/a/")).not.toContain(S);
  });

  test("SC3 — inline interpreter code names only the paths its write calls take", () => {
    expect(targets(`python3 -c "open('.yok/a/state.json','w').write('{}')"`)).toEqual([S]);
    expect(targets(`node -e "require('fs').writeFileSync('.yok/a/state.json','{}')"`)).toEqual([S]);
    expect(
      targets(`python3 -c "from pathlib import Path; Path('.yok/a/state.json').write_text('{}')"`),
    ).toEqual([S]);
    expect(targets(`python3 -c "print(open('.yok/a/state.json').read())"`)).toEqual([]);
    expect(
      targets(
        `python3 -c "import json,os; d=json.load(open('.yok/a/state.json')); os.remove('/tmp/a')"`,
      ),
    ).toEqual(["/tmp/a"]);
    expect(
      targets(`python3 -c "json.dump(json.load(open('.yok/a/state.json')), open('/tmp/c','w'))"`),
    ).toEqual(["/tmp/c"]);
  });

  test("interpreter code fed through a heredoc is checked like inline code", () => {
    const write = ["python3 - <<'EOF'", "open('.yok/a/state.json','w').write('{}')", "EOF"];
    const read = ["node <<EOF", "require('fs').readFileSync('.yok/a/state.json')", "EOF"];
    expect(targets(write.join("\n"))).toEqual([S]);
    expect(targets(read.join("\n"))).toEqual([]);
  });

  test("SC4 — heredoc bodies and quoted text are data", () => {
    const heredoc = [
      "yok orchestrate done n1 --run a --output - <<'JSON'",
      `{"note": "rm .yok/a/state.json"}`,
      "JSON",
    ].join("\n");
    expect(targets(heredoc)).toEqual([]);
    expect(targets(`echo "rm .yok/a/state.json"`)).toEqual([]);
    expect(targets(`git commit -m "fix > .yok/a/state.json"`)).toEqual([]);
  });

  test("comments are not commands, and an apostrophe in one hides nothing", () => {
    expect(targets("rm .yok/a/state.json # don't keep it")).toEqual([S]);
    expect(targets(`# reset the run's record\nrm .yok/a/state.json\necho "it's gone"`)).toEqual([
      S,
    ]);
    expect(targets("echo hi # don't\nmv /tmp/s .yok/a/event.jsonl")).toContain(E);
    expect(targets("echo ok # see > .yok/a/state.json")).toEqual([]);
  });

  test("SC5 — wrappers, chains and cd are followed", () => {
    expect(targets("sudo rm .yok/a/state.json")).toEqual([S]);
    expect(targets("FOO=1 env -i rm x")).toEqual(["/repo/x"]);
    expect(targets("ls && rm .yok/a/event.jsonl")).toEqual([E]);
    expect(targets("cd .yok/a && rm state.json")).toEqual([S]);
    expect(targets("cd ~/.yok && rm registry.json")).toEqual([REGISTRY]);
    expect(targets("cd $YOK_HOME && rm registry.json")).toEqual([REGISTRY]);
  });

  test("home and yok-home spellings expand, and other variables are unknown", () => {
    for (const path of [
      "~/.yok/registry.json",
      "$HOME/.yok/registry.json",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell form under test
      "${HOME}/.yok/registry.json",
      "$YOK_HOME/registry.json",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell form under test
      "${YOK_HOME}/registry.json",
    ]) {
      expect(targets(`rm "${path}"`)).toEqual([REGISTRY]);
    }
    expect(targets("rm $OTHER/registry.json")).toEqual([]);
  });

  test("SC6 — an unclosed quote drops only the segment it is in", () => {
    expect(targets(`rm ".yok/a/state.json`)).toEqual([]);
    // bash will not run a segment with an unclosed quote, so its complete words are not targets either
    expect(targets(`rm .yok/a/state.json "oops`)).toEqual([]);
    expect(targets(`rm .yok/a/state.json; echo 'oops`)).toEqual([S]);
  });

  test("SC7 — the script of a shell -c or eval is scanned as a command", () => {
    expect(targets("bash -c 'rm .yok/a/state.json'")).toEqual([S]);
    expect(targets('sh -lc "mv /tmp/s .yok/a/event.jsonl"')).toContain(E);
    expect(targets('eval "rm .yok/a/state.json"')).toEqual([S]);
    expect(targets("bash -c 'cd .yok/a && rm state.json'")).toEqual([S]);
    expect(targets("bash -c \"bash -c 'rm .yok/a/state.json'\"")).toEqual([S]);
    expect(targets("bash -c 'cat .yok/a/state.json'")).toEqual([]);
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
    expect(expandPath(".yok/a/state.json", BASE)).toBe(S);
    expect(expandPath("~", BASE)).toBe("/home/u");
    expect(expandPath("$UNSET/x", BASE)).toBeUndefined();
  });
});
