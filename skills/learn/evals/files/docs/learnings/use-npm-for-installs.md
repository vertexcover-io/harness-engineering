---
signal: Use when installing or adding a dependency
paths: ["package.json"]
tags: [dependencies, tooling]
strength: default
---
# Install dependencies with npm

Add and install dependencies with `npm install`. The CI pipeline restores `package-lock.json`. `npm install <pkg>`; commit `package-lock.json` with the change.

**Occurrences:**
- 2026-09-12 · agent used yarn and CI failed on a missing lockfile
**Stale when:** `package-lock.json` is replaced by another lockfile.
