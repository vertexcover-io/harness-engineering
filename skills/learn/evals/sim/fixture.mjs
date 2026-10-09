// Builds the dummy monorepo the simulated sessions run in, shaped like a real multi-app repo whose
// sessions were reviewed by hand: two apps (an admin API and an admin panel) and an installed
// shared settings package that already has the place a cross-app list belongs: a flag on
// ACTIVATION_TYPES, read through a helper. Being in node_modules, it is found only by looking.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILES = {
  "package.json": JSON.stringify(
    {
      name: "shop",
      private: true,
      workspaces: ["apps/*"],
      dependencies: { "@shop/shared-config": "^2.3.0", lodash: "^4.17.21", "lodash-es": "^4.17.21" },
      scripts: { lint: "node scripts/lint.mjs", test: "node --test" },
    },
    null,
    2,
  ),
  "README.md": `# shop

Admin tools for business subscriptions.

- \`apps/admin-api\`: the admin back-end (activates and renews subscriptions).
- \`apps/admin-panel\`: the admin UI.
`,
  "node_modules/@shop/shared-config/package.json": JSON.stringify({ name: "@shop/shared-config", version: "2.3.0", main: "src/index.ts", description: "Settings shared by every shop app. Published from the shared-config repo." }, null, 2),
  "node_modules/@shop/shared-config/src/index.ts": `export * from "./activation-types"
`,
  "node_modules/@shop/shared-config/src/activation-types.ts": `export type ActivationType = "SELF_SERVE" | "RESELLER" | "PAYMENT_MANUAL" | "TRIAL"

type ActivationSettings = {
  readonly label: string
  readonly requiresApproval: boolean
}

export const ACTIVATION_TYPES: Readonly<Record<ActivationType, ActivationSettings>> = {
  SELF_SERVE: { label: "Self serve", requiresApproval: false },
  RESELLER: { label: "Reseller", requiresApproval: true },
  PAYMENT_MANUAL: { label: "Manual payment", requiresApproval: true },
  TRIAL: { label: "Trial", requiresApproval: false },
}

export const activationTypesWhere = (flag: keyof Omit<ActivationSettings, "label">): ActivationType[] =>
  (Object.keys(ACTIVATION_TYPES) as ActivationType[]).filter((type) => ACTIVATION_TYPES[type][flag])
`,
  "apps/admin-api/package.json": JSON.stringify({ name: "@shop/admin-api", main: "src/index.ts" }, null, 2),
  "apps/admin-api/src/subscriptions/activate.ts": `import { db } from "../db"

export type ActivationType = "SELF_SERVE" | "RESELLER" | "PAYMENT_MANUAL" | "TRIAL"

export type ActivateInput = {
  readonly businessId: string
  readonly activationType: ActivationType
  readonly approvedBy?: string
}

export const activateSubscription = async (input: ActivateInput) => {
  const business = await db.businesses.find(input.businessId)
  if (!business) throw new Error("business not found")
  return db.subscriptions.insert({
    businessId: input.businessId,
    activationType: input.activationType,
    approvedBy: input.approvedBy ?? null,
    activatedAt: new Date(),
  })
}
`,
  "apps/admin-api/src/db.ts": `type Row = Record<string, unknown>
const table = () => {
  const rows: Row[] = []
  return {
    find: async (id: string) => rows.find((row) => row.id === id) ?? { id },
    all: async () => rows,
    where: async (match: (row: Row) => boolean) => rows.filter(match),
    insert: async (row: Row) => {
      rows.push(row)
      return row
    },
  }
}
export const db = { businesses: table(), subscriptions: table(), invoices: table() }
`,
  "apps/admin-panel/package.json": JSON.stringify({ name: "@shop/admin-panel", main: "src/index.ts" }, null, 2),
  "apps/admin-panel/src/ActivateForm.tsx": `import { useState } from "react"

type ActivationType = "SELF_SERVE" | "RESELLER" | "PAYMENT_MANUAL" | "TRIAL"

export const ActivateForm = ({ onSubmit }: { onSubmit: (type: ActivationType) => void }) => {
  const [type, setType] = useState<ActivationType>("SELF_SERVE")
  return (
    <form onSubmit={() => onSubmit(type)}>
      <select value={type} onChange={(e) => setType(e.target.value as ActivationType)}>
        <option value="SELF_SERVE">Self serve</option>
        <option value="RESELLER">Reseller</option>
        <option value="PAYMENT_MANUAL">Manual payment</option>
        <option value="TRIAL">Trial</option>
      </select>
      <button type="submit">Activate</button>
    </form>
  )
}
`,
  "apps/admin-api/src/routes.ts": `import { db } from "./db"

type Request = { readonly params: Record<string, string>; readonly query: Record<string, string | undefined> }
type Router = { get: (path: string, handler: (req: Request) => Promise<unknown>) => void }

export const registerRoutes = (router: Router) => {
  router.get("/businesses", async () => db.businesses.all())
  router.get("/businesses/:id", async (req) => db.businesses.find(req.params.id))
}
`,
  "apps/admin-api/src/lib/errors.ts": `// The router turns an HttpError into its status code; any other error becomes a 500.
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}
`,
  "apps/admin-api/src/lib/logger.ts": `// Structured logger: lines go to the log pipeline and are searchable in Grafana.
export const logger = {
  info: (msg: string, fields: Record<string, unknown> = {}) => process.stdout.write(JSON.stringify({ level: "info", msg, ...fields }) + "\\n"),
  error: (msg: string, fields: Record<string, unknown> = {}) => process.stdout.write(JSON.stringify({ level: "error", msg, ...fields }) + "\\n"),
}
`,
  "apps/admin-api/src/lib/sentry.ts": `// Errors sent here page the on-call engineer.
export const captureException = (error: unknown, context: Record<string, unknown> = {}) => {
  void error
  void context
}
`,
  "apps/admin-api/src/jobs/README.md": `Background jobs run nightly from cron. Nobody watches their console output.
`,
  "scripts/lint.mjs": `// Stand-in lint: fails on console.log in app code.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? walk(path) : [path]
})
const bad = walk("apps").filter((file) => readFileSync(file, "utf8").includes("console.log"))
if (bad.length > 0) {
  console.error("console.log in:", bad.join(", "))
  process.exit(1)
}
console.log("lint ok")
`,
  ".gitignore": "node_modules\n.harness/*\n!.harness/knowledge/\n.yok/*\n!.yok/knowledge/\n",
};

export const createRepo = (dir, extraFiles = {}) => {
  for (const [path, content] of Object.entries({ ...FILES, ...extraFiles })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const git = (...args) => spawnSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=dev", "-c", "user.email=dev@shop.test", "commit", "-qm", "init");
};
