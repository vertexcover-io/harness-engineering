# Issue Format Reference

This file defines the GitHub issue body format for the tech-debt-finder skill. When building the issue body in Step 5b, follow this specification exactly.

---

## Layout

Build the issue body in this order:

```
1. Title + scan metadata
2. Hotspots table
3. Category sections (collapsible)
4. Recommended actions
5. Notes
```

---

## Section 1: Title + Metadata

```markdown
# Tech Debt Audit — {scope}

**Scanned:** {file_count} files | **Date:** {YYYY-MM-DD}
**Findings:** {critical} critical | {high} high | {medium} medium | {low} low
```

---

## Section 2: Hotspots

Files with 3+ findings, sorted by finding count descending. **Omit this section entirely if no file has 3+ findings.**

```markdown
## Hotspots

| File | Findings | Highest |
|------|----------|---------|
| `{file}` | {count} | {severity} |
```

---

## Section 3: Category Sections

Each category is a collapsible `<details>` block. **Omit categories with 0 findings entirely.**

### Severity Badges

Two forms are used depending on context:

| Severity | Full badge (in findings) | Short badge (in headers) |
|----------|--------------------------|--------------------------|
| Critical | `🔴 CRITICAL` | `🔴 critical` |
| High | `🟠 HIGH` | `🟠 high` |
| Medium | `🟡 MEDIUM` | `🟡 medium` |
| Low | `🟢 LOW` | `🟢 low` |

Critical and High use different emoji (🔴 vs 🟠) so they are always distinguishable.

### Category Ordering

Categories are ordered by highest severity found, then by total finding count:

1. Categories with Critical findings first
2. Then categories with High findings
3. Then Medium-only
4. Then Low-only

Within the same tier, more findings sorts first.

### Category Explainers

Agents return hyphenated lowercase category keys. Display names in the issue use title-case.

| Agent category key | Display name | Explainer |
|--------------------|--------------|-----------|
| `architecture` | Architecture | Modules or layers with too many responsibilities — hard to navigate, test, and modify safely. |
| `complexity` | Complexity | Functions with too many branches or deeply nested logic — harder to test, review, and modify safely. |
| `code-smell` | Code Smell | Patterns that aren't bugs today but signal weak typing or hidden state — making future changes riskier. |
| `error-handling` | Error Handling | Exceptions being silenced or caught too broadly — hiding failures and making production issues harder to diagnose. |
| `duplication` | Duplication | Near-identical code blocks that must be changed in lockstep — when one copy gets fixed and others don't, bugs diverge silently. |
| `dependency` | Dependency | Issues with how external packages are declared — missing bounds, unused packages, or circular import workarounds. |
| `async` | Async | Blocking calls inside async functions — stalling the event loop and degrading throughput for all concurrent requests. |

### Outer Level — Category

The severity counts in the header use the **short badge** form. Only include severity tiers that have findings in this category.

```html
<details>
<summary><strong>{Display Name}</strong> — {total} findings ({N} {short_badge}, {M} {short_badge})</summary>

> {Category explainer from table above}

<!-- file sub-groups here -->

</details>
```

Separate each category `<details>` block with a `---` horizontal rule.

### Inner Level — File/Module Sub-group

Each file within a category gets a nested `<details>` block. **If a category has findings in only one file, skip the inner `<details>` and render findings directly under the category explainer.**

File sub-groups are ordered by:
1. Highest severity finding first
2. Then finding count descending
3. Then alphabetically

```html
<details>
<summary><code>{file_path}</code> — {count} findings</summary>

- [ ] 🟠 HIGH · `{file}:{line}` — **{short title}**
  {one-line explanation of why this matters}

- [ ] 🟡 MEDIUM · `{file}:{line}` — **{short title}**
  {one-line explanation of why this matters}

</details>
```

### Finding Format

Each finding is a checkbox with the **full badge** form, a middle dot separator, file location, bold title, and a one-line explanation:

```markdown
- [ ] {full_badge} · `{file}:{line}` — **{short title}**
  {one-line explanation of why this matters}
```

The `detail` field returned by scanner agents provides the explanation line.

---

## Section 4: Recommended Actions

Only include severity tiers that have actual findings. Omit tiers with 0 findings.

```markdown
## Recommended Actions

1. **Critical** — fix immediately, security/correctness risks
2. **High** — schedule for current sprint, use `/refactor` for code-level fixes
3. **Medium** — plan for next sprint, use `/planning` for architectural items
4. **Low** — address opportunistically during related work
```

---

## Section 5: Notes

Rendered after Recommended Actions as the final section. Include any skipped checks or tool availability issues.

```markdown
**Notes:** {notes about skipped checks, missing tools, etc.}
```

---

## Truncation Rules

GitHub issues have a 65536 character body limit. If the body exceeds 60000 characters:

1. Truncate **Low** findings first, replacing with: `... and {N} more 🟢 LOW findings`
2. If still too large, truncate **Medium** findings similarly
3. Never truncate Critical or High findings

---

## Full Example

Below is a complete issue body using real data, demonstrating all sections, both nesting levels, the single-file shortcut, and severity badges.

```markdown
# Tech Debt Audit — tarash (repo root)

**Scanned:** 115 files | **Date:** 2026-03-18
**Findings:** 0 critical | 11 high | 33 medium | 10 low

## Hotspots

| File | Findings | Highest |
|------|----------|---------|
| `providers/cartesia.py` | 5 | Medium |
| `providers/elevenlabs.py` | 5 | Medium |
| `providers/google.py` | 4 | High |
| `providers/replicate.py` | 3 | High |
| `providers/hume.py` | 3 | Medium |
| `providers/sarvam.py` | 3 | Medium |
| `registry.py` | 3 | Medium |

---

<details>
<summary><strong>Architecture</strong> — 3 findings (3 🟠 high)</summary>

> Modules or layers with too many responsibilities — hard to navigate, test, and modify safely.

<details>
<summary><code>providers/fal.py</code> — 1 finding</summary>

- [ ] 🟠 HIGH · `fal.py:1` — **God module: 2288 lines spanning video, image, and TTS**
  Three distinct domains packed into a single file. Changes to image generation risk breaking TTS logic.

</details>

<details>
<summary><code>providers/google.py</code> — 1 finding</summary>

- [ ] 🟠 HIGH · `google.py:1` — **God module: 1241 lines spanning video and image generation**
  Two unrelated provider domains sharing one file, increasing coupling and cognitive load.

</details>

<details>
<summary><code>providers/replicate.py</code> — 1 finding</summary>

- [ ] 🟠 HIGH · `replicate.py:1` — **God module: 1267 lines spanning video and image generation**
  Same pattern as google.py — two domains in one file preventing independent testing.

</details>

</details>

---

<details>
<summary><strong>Complexity</strong> — 19 findings (7 🟠 high, 12 🟡 medium)</summary>

> Functions with too many branches or deeply nested logic — harder to test, review, and modify safely.

<details>
<summary><code>providers/google.py</code> — 2 findings</summary>

- [ ] 🟠 HIGH · `google.py:308` — **CC=29 in `_convert_request`**
  29 independent code paths — nearly impossible to test exhaustively.

- [ ] 🟡 MEDIUM · `google.py:560` — **CC=15 in `_handle_error`**
  Error classification logic with 15 branches. Easy to miss an error type.

</details>

<details>
<summary><code>providers/replicate.py</code> — 2 findings</summary>

- [ ] 🟠 HIGH · `replicate.py:547` — **CC=21 in `_convert_response`**
  Response conversion with 21 paths handled via deeply branched conditionals.

- [ ] 🟡 MEDIUM · `replicate.py:990` — **Deep nesting (6 levels) in `_convert_image_response`**
  Deeply nested conditionals make it hard to trace which branch executes for a given input.

</details>

<details>
<summary><code>providers/runway.py</code> — 2 findings</summary>

- [ ] 🟠 HIGH · `runway.py:297` — **CC=22 in `_convert_request`**
  22 code paths in request conversion, likely candidates for extract-method refactoring.

- [ ] 🟡 MEDIUM · `runway.py:580` — **CC=13 in `_poll_until_complete`**
  Polling loop with 13 branches handling various completion/failure states.

</details>

<details>
<summary><code>providers/field_mappers.py</code> — 2 findings</summary>

- [ ] 🟠 HIGH · `field_mappers.py:168` — **CC=16 in `single_image_field_mapper`**
  Field mapping with 16 branches — handling too many format variations in one function.

- [ ] 🟠 HIGH · `field_mappers.py:195` — **CC=16 in converter closure**
  A closure doing too much conditional work in a single scope.

</details>

<details>
<summary><code>tools/linter/runner.py</code> — 2 findings</summary>

- [ ] 🟠 HIGH · `runner.py:20` — **CC=18 in `parse_registry_mapping`**
  Parsing logic with 18 branches. Consider splitting by mapping format.

- [ ] 🟠 HIGH · `runner.py:171` — **CC=17 in `run_lint`**
  Core linting orchestration with 17 paths — too much in a single function.

</details>

<details>
<summary><code>providers/cartesia.py</code> — 1 finding</summary>

- [ ] 🟡 MEDIUM · `cartesia.py:292` — **Deep nesting (6 levels) in `_handle_error`**
  Error handler buried under 6 levels of conditionals.

</details>

<details>
<summary><code>providers/elevenlabs.py</code> — 1 finding</summary>

- [ ] 🟡 MEDIUM · `elevenlabs.py:241` — **Deep nesting (6 levels) in `_handle_error`**
  Same deep-nesting pattern as cartesia — likely share a common structure.

</details>

<details>
<summary><code>providers/hume.py</code> — 1 finding</summary>

- [ ] 🟡 MEDIUM · `hume.py:197` — **Deep nesting (6 levels) in `_handle_error`; duplicated with sarvam**
  Deeply nested and nearly identical to sarvam's handler.

</details>

<details>
<summary><code>providers/sarvam.py</code> — 1 finding</summary>

- [ ] 🟡 MEDIUM · `sarvam.py:171` — **Deep nesting (6 levels) in `_handle_error`; duplicated with hume**
  Mirror image of hume's handler — a shared base error handler would eliminate both.

</details>

<details>
<summary><code>image_format.py</code> — 1 finding</summary>

- [ ] 🟡 MEDIUM · `image_format.py:77` — **CC=13 in `ensure_image_format`**
  Format conversion with 13 branches handling multiple image formats inline.

</details>

<details>
<summary><code>logging.py</code> — 1 finding</summary>

- [ ] 🟡 MEDIUM · `logging.py:21` — **CC=14 in `_redact_value`; also `Any` overuse**
  Redaction logic with 14 branches checking for different sensitive value patterns.

</details>

<details>
<summary><code>registry.py</code> — 1 finding</summary>

- [ ] 🟡 MEDIUM · `registry.py:31` — **CC=15 / deep nesting (12 levels) in `get_handler`**
  A 12-level deep if/elif chain — a registry dict would flatten this entirely.

</details>

</details>

---

<details>
<summary><strong>Code Smell</strong> — 16 findings (16 🟡 medium)</summary>

> Patterns that aren't bugs today but signal weak typing or hidden state — making future changes riskier.

<details>
<summary><code>providers/cartesia.py</code> — 3 findings</summary>

- [ ] 🟡 MEDIUM · `cartesia.py:178` — **`_get_client() -> Any` could use `Cartesia | AsyncCartesia`**
  Returning `Any` hides the client type from callers. The SDK exports proper types.

- [ ] 🟡 MEDIUM · `cartesia.py:227` — **`_resolve_audio_local(audio: Any)` could use `MediaType`**
  Accepting `Any` means the function signature communicates nothing about valid inputs.

- [ ] 🟡 MEDIUM · `cartesia.py:240` — **`_resolve_audio_bytes(audio: Any)` could use `MediaType`**
  Same issue — callers have no guidance on what to pass.

</details>

<details>
<summary><code>providers/elevenlabs.py</code> — 3 findings</summary>

- [ ] 🟡 MEDIUM · `elevenlabs.py:120` — **`_get_client() -> Any` could use union type**
  SDK exports `ElevenLabs | AsyncElevenLabs`. Using `Any` opts out of type safety.

- [ ] 🟡 MEDIUM · `elevenlabs.py:148` — **`_resolve_audio_local(audio: Any)` could use `MediaType`**
  Untyped parameter makes this function a black box to callers.

- [ ] 🟡 MEDIUM · `elevenlabs.py:162` — **`_resolve_audio_bytes(audio: Any)` could use `MediaType`**
  `Any` in, `Any` out means no static checks are possible.

</details>

<details>
<summary><code>providers/hume.py</code> — 2 findings</summary>

- [ ] 🟡 MEDIUM · `hume.py:120` — **`_get_client() -> Any` could use union type**
  Losing type information at the client boundary.

- [ ] 🟡 MEDIUM · `hume.py:157` — **`_convert_tts_response(hume_result: Any)` undocumented Any**
  The SDK provides response types — using them catches response-shape changes at type-check time.

</details>

<details>
<summary><code>providers/sarvam.py</code> — 2 findings</summary>

- [ ] 🟡 MEDIUM · `sarvam.py:96` — **`_get_client() -> Any` could use union type**
  Same pattern across all TTS providers — worth fixing as a batch.

- [ ] 🟡 MEDIUM · `sarvam.py:140` — **`_convert_tts_response(sarvam_result: Any)` undocumented Any**
  Response type is known from the SDK but not communicated in the signature.

</details>

<details>
<summary><code>providers/openai.py</code> — 1 finding</summary>

- [ ] 🟡 MEDIUM · `openai.py:1082` — **`_convert_image_response(provider_response: Any)` — SDK exports `ImagesResponse`**
  Using the SDK type would catch breaking changes on upgrades.

</details>

<details>
<summary><code>providers/google.py</code> — 1 finding</summary>

- [ ] 🟡 MEDIUM · `google.py:770` — **`_convert_gemini_image_response(response: Any)` — SDK exports types**
  `Any` bypasses all static analysis benefits the SDK provides.

</details>

<details>
<summary><code>mock.py</code> — 1 finding</summary>

- [ ] 🟡 MEDIUM · `mock.py:341` — **Global mutable state: `_async_cache` dict grows unbounded, not thread-safe**
  A module-level dict that grows without eviction. Concurrent writes risk data corruption.

</details>

<details>
<summary><code>registry.py</code> — 1 finding</summary>

- [ ] 🟡 MEDIUM · `registry.py:28` — **Global mutable state: `_HANDLER_INSTANCES` dict, not thread-safe**
  Singleton cache that mutates on first access. Concurrent async requests could see partial state.

</details>

</details>

---

<details>
<summary><strong>Error Handling</strong> — 1 finding (1 🟠 high)</summary>

> Exceptions being silenced or caught too broadly — hiding failures and making production issues harder to diagnose.

- [ ] 🟠 HIGH · `utils.py:242` — **Swallowed exception: `except Exception: pass` in `_extract_filename_from_url`**
  If URL parsing fails, the caller gets `None` with no indication that an error occurred. Failures are silent and invisible in logs.

</details>

---

<details>
<summary><strong>Duplication</strong> — 3 findings (3 🟡 medium)</summary>

> Near-identical code blocks that must be changed in lockstep — when one copy gets fixed and others don't, bugs diverge silently.

<details>
<summary><code>exceptions.py</code> — 1 finding</summary>

- [ ] 🟡 MEDIUM · `exceptions.py:240` — **Duplicated error-handling decorators: video vs audio are near-identical**
  Two decorators doing the same error-wrapping with different exception types. A parameterized decorator would eliminate the duplication.

</details>

<details>
<summary><code>orchestrator.py</code> — 1 finding</summary>

- [ ] 🟡 MEDIUM · `orchestrator.py:60` — **8 near-identical execute methods repeating fallback-chain pattern**
  Eight methods with the same try/fallback/retry structure. A generic `_execute_with_fallback` would replace all of them.

</details>

<details>
<summary><code>providers/hume.py + providers/sarvam.py</code> — 1 finding</summary>

- [ ] 🟡 MEDIUM · `hume.py:197` + `sarvam.py:171` — **Near-identical `_handle_error` implementations**
  Copy-pasted error handlers. A shared base class method would keep them in sync.

</details>

</details>

---

<details>
<summary><strong>Dependency</strong> — 12 findings (2 🟡 medium, 10 🟢 low)</summary>

> Issues with how external packages are declared — missing bounds, unused packages, or circular import workarounds.

<details>
<summary><code>exceptions.py</code> — 1 finding</summary>

- [ ] 🟡 MEDIUM · `exceptions.py:11` — **Circular dependency signal: TYPE_CHECKING import from models**
  Using `if TYPE_CHECKING:` to break a circular import. The real fix is untangling the dependency.

</details>

<details>
<summary><code>models.py</code> — 1 finding</summary>

- [ ] 🟡 MEDIUM · `models.py:21` — **Circular dependency signal: TYPE_CHECKING import from mock**
  Models and mock shouldn't need to know about each other at runtime.

</details>

<details>
<summary><code>pyproject.toml</code> — 1 finding</summary>

- [ ] 🟢 LOW · `pyproject.toml:4` — **Placeholder project description "Add your description here"**
  Looks unfinished to anyone discovering the package.

</details>

<details>
<summary><code>tarash-gateway/pyproject.toml</code> — 9 findings</summary>

- [ ] 🟢 LOW · `pyproject.toml:11` — **Pinning gap: `pydantic>=2.0.0` no upper bound**
  A future pydantic 3.0 could break serialization without warning.

- [ ] 🟢 LOW · `pyproject.toml:12` — **Pinning gap: `httpx>=0.25.0` no upper bound**

- [ ] 🟢 LOW · `pyproject.toml:16` — **Pinning gap: `fal-client>=0.4.0` no upper bound**

- [ ] 🟢 LOW · `pyproject.toml:17` — **Pinning gap: `google-genai>=1.0.0` no upper bound**

- [ ] 🟢 LOW · `pyproject.toml:18` — **Pinning gap: `openai>=1.0.0` (installed 2.24.0 — crossed major)**
  Already running a major version ahead of the lower bound.

- [ ] 🟢 LOW · `pyproject.toml:20` — **Unused dependency: `google-cloud-aiplatform` never imported**
  Dead weight in the dependency tree.

- [ ] 🟢 LOW · `pyproject.toml:21` — **Pinning gap: `runwayml>=3.0.0` (installed 4.6.2 — crossed major)**

- [ ] 🟢 LOW · `pyproject.toml:23` — **Pinning gap: `elevenlabs>=1.0.0` (installed 2.37.0 — crossed major)**

- [ ] 🟢 LOW · `pyproject.toml:24` — **Pinning gap: `cartesia>=1.0.0` (installed 3.0.2 — crossed major)**

</details>

</details>

---

## Recommended Actions

1. **High** — schedule for current sprint, use `/refactor` for code-level fixes
   - Split god modules (`fal.py`, `google.py`, `replicate.py`) by domain
   - Break down high-CC functions with extract-method refactoring
   - Fix the swallowed exception in `utils.py`
2. **Medium** — plan for next sprint, use `/planning` for architectural items
   - Replace `Any` return types with proper SDK types
   - Deduplicate orchestrator methods and error-handling decorators
   - Add thread-safety to global mutable caches
3. **Low** — address opportunistically during related work
   - Add upper-bound pins for dependencies that crossed major versions
   - Remove unused `google-cloud-aiplatform` dependency

**Notes:** CVE checks skipped — `pip-audit` not installed. Complexity computed via AST-based calculation (`radon` not available).
```
