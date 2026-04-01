---
name: project-scaffold
description: >
  Scaffold a full TypeScript project from a tech stack spec document. Creates Turborepo workspace,
  all packages with starter code, Podman Compose for local infra (PostgreSQL, Redis, etc.),
  and verifies the setup builds and runs. Use this skill whenever the user wants to set up a new
  TypeScript project, scaffold a project from a spec, bootstrap a multi-package TS project,
  or says "set up the project", "create the project", "scaffold", "bootstrap", "init the repo".
  Also triggers when the user has a tech stack design doc and wants to turn it into a working project.
argument-hint: "<path/to/spec.md> [--dir <path>]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
user-invocable: true
---

# Project Scaffold

Reads a tech stack spec document and scaffolds a complete, buildable TypeScript project with all packages, configs, starter code, and local development infrastructure.

**Announce at start:** "Using the project-scaffold skill to set up your project."

---

## Input

The argument is a **path to a spec document** (Markdown) that describes:
- The packages/services in the monorepo and their responsibilities
- The tech stack (frameworks, database, queue, etc.)
- The monorepo structure

Optionally, the user can specify:
- `--dir <path>` — Directory to scaffold in. Default: **current working directory**. If the directory is not empty (excluding docs/specs), ask the user before proceeding.

The **package manager** is read from the spec document. If the spec doesn't specify one, default to **pnpm**.

---

## Process

### Step 1: Parse the Spec

Read the spec document and extract:

1. **Packages** — name, scope (e.g., `@myproject/api`), purpose, framework
2. **Tech stack** — every technology choice (ORM, queue, email provider, etc.)
3. **Package manager** — pnpm, npm, or yarn. If not specified in the spec, default to pnpm.
4. **Infrastructure** — databases, caches, queues that need local containers
5. **Monorepo structure** — directory layout from the spec

If the spec is ambiguous or missing critical info (e.g., no clear package list), stop and ask the user before proceeding. Don't guess at architecture.

### Step 2: Scaffold Root

Use CLI tools to generate the initial setup — don't hand-write config files when a generator exists.

1. **Initialize git** (if not already a repo): `git init`
2. **Create Turborepo workspace** using the official CLI:
   ```bash
   npx create-turbo@latest <project-name> --package-manager <pnpm|npm|yarn>
   ```
   This generates the root `package.json`, `turbo.json`, `pnpm-workspace.yaml` (or equivalent), `tsconfig.json`, and `.gitignore` with correct defaults.
3. **Clean up the generated template** — remove any example/starter packages that `create-turbo` creates (e.g., `apps/web`, `apps/docs`, `packages/ui`). Restructure directories to match the spec's layout (e.g., if the spec uses a flat `packages/` structure but `create-turbo` created `apps/` and `packages/`, consolidate to match the spec). Update `pnpm-workspace.yaml` (or equivalent) accordingly.
4. **Add shared dev dependencies** to root: `typescript`, `@types/node`, `tsup`
5. **Update `turbo.json`** pipeline if needed:
   - `build` depends on `^build` (topological)
   - `dev` is persistent
   - `lint` and `typecheck` have no dependencies
6. **Update root `tsconfig.json`** — enable strict mode if not already set
7. **Create `.env.example`** — with all required environment variables from the spec (DB URL, Redis URL, API keys, etc.)
8. **Create `.env`** — copy `.env.example` to `.env` with working local dev defaults so the project runs out of the box. Add `.env` to `.gitignore`.

### Step 3: Scaffold Each Package

For each package identified in the spec, use CLI generators where available. Fall back to manual creation only for packages that don't have a standard generator.

Each package needs:
- `package.json` with correct dependencies, scripts (`dev`, `build`), and workspace references
- `tsconfig.json` extending the root config
- `src/index.ts` entry point
- Framework-specific starter code based on what the spec says the package uses

**The spec determines the setup, not this skill.** For each package, look up whether the framework it uses has an official CLI scaffolder (e.g., `npm create vite@latest`, `npm create hono@latest`, `npm create next-app@latest`). If one exists, use it. If not, run `<package-manager> init` and create the starter code manually.

#### How to scaffold a package:

1. **Check if the framework has a CLI generator.** Most popular frameworks do — Vite, Next.js, Hono, Remix, SvelteKit, Fastify, Nest, etc. Search the framework's docs if unsure.
2. **If a CLI exists:** Run it targeting the package directory. Clean up any files that don't fit the monorepo structure (e.g., duplicate `.gitignore`, separate `node_modules`).
3. **If no CLI exists:** Run `<package-manager> init` in the package directory to generate `package.json`, then create `src/index.ts` and the directory structure described in the spec.
4. **After scaffolding:** Update the `package.json` name to match the workspace scope from the spec (e.g., `@myapp/api`). Ensure scripts (`dev`, `build`) are consistent across packages.

### Step 4: Podman Compose for Local Infrastructure

Create a `compose.yml` at the project root for any infrastructure the spec mentions (databases, caches, queues, etc.). For each service:

- Use the official image from the spec (e.g., `postgres:16`, `redis:7`)
- Map ports to localhost with sensible defaults
- Set environment variables matching `.env.example`
- Add named volumes for data persistence across restarts

Add scripts to root `package.json`:
- `infra:up` — `podman-compose up -d`
- `infra:down` — `podman-compose down`
- `infra:reset` — `podman-compose down -v && podman-compose up -d`

The compose file is compatible with both Docker and Podman. Scripts default to `podman-compose` — if the user prefers Docker, they can alias or swap the command.

### Step 5: Wire Up Cross-Package Dependencies

1. Add workspace references between packages (e.g., `api` depends on `shared`)
2. Ensure TypeScript path aliases resolve correctly across packages
3. Verify `turbo.json` build pipeline respects the dependency graph

### Step 6: Install and Verify

This step confirms the scaffold actually works. Don't skip it.

1. **Install dependencies:** Run the package manager install command
2. **Start infrastructure:** Run `podman-compose up -d` and wait for containers to be healthy
3. **Build all packages:** Run `turbo build` — every package must compile without errors
4. **Type check:** Run `turbo typecheck` — must pass with zero errors
5. **Quick smoke test:** If the API package has a health check, start it briefly and curl the endpoint

If any step fails, fix the issue before proceeding. Common problems:
- Missing peer dependencies — add them
- TypeScript path resolution — check `tsconfig.json` references
- Podman not available — inform the user, don't silently skip

After verification, stop the infrastructure: `podman-compose down`

### Step 7: Summary

Present a summary to the user listing:

- **Packages created** — name, scope, and one-line description for each
- **Infrastructure** — each container service with its mapped port
- **Key commands** — `infra:up`, `dev`, `build`, `typecheck` with the correct package manager prefix

---

## Key Principles

- **The spec is the source of truth.** Don't add packages, frameworks, or infrastructure that aren't in the spec. Don't omit things that are.
- **Every package must build.** The scaffold isn't done until `turbo build` passes. Starter code should be minimal but compilable.
- **Use real dependencies.** Install actual npm packages at their latest versions. Don't leave placeholder version numbers.
- **Environment variables over hardcoded values.** Database URLs, ports, API keys — all go in `.env.example` with sensible defaults for local dev.
- **Container runtime.** Default to `podman-compose` for infrastructure commands. The compose file itself is compatible with both Docker and Podman — users can swap if needed.
