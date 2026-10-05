import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"

const INSTALL = fileURLToPath(new URL("../install.sh", import.meta.url))
const PATH_LINE = 'case ":$PATH:" in *":$HOME/.yok/bin:"*) ;; *) export PATH="$HOME/.yok/bin:$PATH" ;; esac'
const ASSET = `yok-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`

const temp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

// A stand-in release binary: prints its version, and logs "VERSION ARGS" for anything else.
const fakeYok = (version: string, log: string): string =>
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\necho "${version} $*" >> "${log}"\n`

const releaseFiles = (version: string, log: string, checksum?: string): Record<string, string> => {
  const script = fakeYok(version, log)
  return { [ASSET]: script, "checksums.txt": `${checksum ?? sha256(script)}  ${ASSET}\n` }
}

const servers: { close: () => void }[] = []
after(() => servers.forEach((server) => server.close()))

// Serves FILES by path; returns the server's base URL.
const serve = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const server = createServer((request, response) => {
    const body = files[request.url ?? ""]
    response.writeHead(body === undefined ? 404 : 200)
    response.end(body ?? "")
  })
  servers.push(server)
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("the release server has no port")
  return `http://127.0.0.1:${address.port}`
}

const under = (prefix: string, files: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(files).map(([name, body]) => [`${prefix}/${name}`, body]))

const fakeAgents = (agents: readonly string[]): string => {
  const bin = temp("yok-agents-")
  agents.forEach((agent) => {
    writeFileSync(join(bin, agent), "#!/bin/sh\nexit 0\n")
    chmodSync(join(bin, agent), 0o755)
  })
  return bin
}

type Installed = { readonly code: number | null; readonly stdout: string; readonly stderr: string }

// Async, because the release server answers from this same process.
const install = (home: string, url: string, agentBin: string, env: Record<string, string> = {}): Promise<Installed> =>
  new Promise((done) => {
    const child = spawn("sh", [INSTALL], {
      env: { HOME: home, SHELL: "/bin/zsh", PATH: `${agentBin}:/usr/bin:/bin`, YOK_RELEASE_URL: url, ...env },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("close", (code) => done({ code, stdout, stderr }))
  })

const logLines = (log: string): readonly string[] =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []

const pathLines = (home: string): number =>
  readFileSync(join(home, ".zshrc"), "utf8")
    .split("\n")
    .filter((line) => line === PATH_LINE).length

describe("install.sh", () => {
  test("SC138: installs the verified binary, adds the PATH line once over two runs, and installs the plugin for claude only", async () => {
    const home = temp("yok-install-home-")
    const log = join(temp("yok-install-log-"), "log")
    const url = await serve(under("", releaseFiles("0.0.9", log)))
    const agents = fakeAgents(["claude"])

    const first = await install(home, url, agents)
    const second = await install(home, url, agents)

    assert.equal(first.code, 0, first.stderr)
    assert.equal(second.code, 0, second.stderr)
    const binary = join(home, ".yok/bin/yok")
    assert.ok((statSync(binary).mode & 0o111) !== 0)
    assert.equal(pathLines(home), 1)
    assert.deepEqual(logLines(log), ["0.0.9 plugin install --agent claude", "0.0.9 plugin install --agent claude"])
    assert.match(second.stdout.trim().split("\n").at(-1) ?? "", /^yok 0\.0\.9 is ready/)
  })

  test("SC139: stops on a checksum mismatch and installs nothing", async () => {
    const home = temp("yok-install-home-")
    const log = join(temp("yok-install-log-"), "log")
    const url = await serve(under("", releaseFiles("0.0.9", log, "0".repeat(64))))

    const result = await install(home, url, fakeAgents(["claude"]))

    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /checksum mismatch/)
    assert.equal(existsSync(join(home, ".yok/bin/yok")), false)
    assert.deepEqual(readdirSync(home), [])
  })

  test("SC140: YOK_AGENTS=codex installs only codex's plugin, and no agent on PATH names the later install command", async () => {
    const log = join(temp("yok-install-log-"), "log")
    const url = await serve(under("", releaseFiles("0.0.9", log)))

    const limited = await install(temp("yok-install-home-"), url, fakeAgents(["claude", "codex"]), {
      YOK_AGENTS: "codex",
    })
    assert.equal(limited.code, 0, limited.stderr)
    assert.deepEqual(logLines(log), ["0.0.9 plugin install --agent codex"])

    const none = await install(temp("yok-install-home-"), url, fakeAgents([]))
    assert.equal(none.code, 0, none.stderr)
    assert.deepEqual(logLines(log), ["0.0.9 plugin install --agent codex"])
    assert.match(none.stdout, /yok plugin install --agent claude/)
  })

  test("SC144: running it again with a newer release moves both the binary and the plugin", async () => {
    const home = temp("yok-install-home-")
    const log = join(temp("yok-install-log-"), "log")
    const url = await serve({
      ...under("/v0.0.1", releaseFiles("0.0.1", log)),
      ...under("/v0.0.2", releaseFiles("0.0.2", log)),
    })
    const agents = fakeAgents(["claude"])

    const older = await install(home, `${url}/v0.0.1`, agents)
    const newer = await install(home, `${url}/v0.0.2`, agents)

    assert.equal(older.code, 0, older.stderr)
    assert.equal(newer.code, 0, newer.stderr)
    const binary = join(home, ".yok/bin/yok")
    assert.equal(spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim(), "0.0.2")
    assert.equal(logLines(log).filter((line) => line.endsWith("plugin install --agent claude")).at(-1), "0.0.2 plugin install --agent claude")
    assert.equal(pathLines(home), 1)
  })
})
