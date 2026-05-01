# Visual rubric — atomic verdicts, no free-form "OK"

The fastest way a vision LLM hides a defect is by writing one token: `verdict: OK`. This rubric replaces that token with a structured JSON form that has to be filled out per failure mode, per component, with rect-grounded evidence. Every field has three possible values: `MET`, `UNMET`, `CANNOT_ASSESS` — never bare boolean, never free text.

The single most important rule: **`MET` without `evidence` is a verification failure.** A reviewer reading the report should be able to verify any `MET` by re-running the cited rect, query, or pixel check.

## Step A — Inventory before any prose

Before writing a single sentence about a screenshot, run this in `browser_evaluate` and dump the result verbatim into `verification/ui/<route>.controls.json`:

```js
() => {
  const sels = ['button', 'a[href]', 'input', 'select', 'textarea', '[role="button"]', '[role="link"]', '[data-dnd-handle]'];
  const items = Array.from(document.querySelectorAll(sels.join(',')))
    .filter(el => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.pointerEvents !== 'none';
    })
    .map((el, i) => {
      const r = el.getBoundingClientRect();
      return {
        id: i,
        tag: el.tagName,
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 60),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        ariaLabel: el.getAttribute('aria-label'),
        nearestComponent: el.closest('[data-component], article, li, .card, [class*="Card"]')?.getAttribute('data-component') || null,
      };
    });
  return items;
}
```

Prose that follows must reference these `id`s. "The trash icon (id 14)" beats "the trash icon".

## Step B — Per-component pairwise (mandatory when N≥2)

When a route renders the same component ≥2 times (cards, rows, list items), tight-crop the bounding rect of two instances using `browser_take_screenshot` with the `target` set to a unique selector for each. Save as `<route>-<component>-i<N>.png`.

Then, in a single prompt, hand the model both crops with one question:

> "These are two instances of the same component. For each interactive control visible in crop 1, locate the same control in crop 2 by role/label. Are the relative positions identical (same row, same column, same offset)? Answer per-control with `IDENTICAL | DIFFERENT | MISSING_IN_CROP_2`. Do not summarize — list every control."

VLMs are dramatically better at *comparison* than absolute judgment. This is also the primary mechanism Applitools markets. (Source: arXiv 2501.09236 layout-bug paper; Applitools Eyes product docs.)

## Step C — The atomic verdict block

For every PNG under `verification/ui/`, append a JSON block (not prose) to `observations.md`:

```json
{
  "screenshot": "review-375-card-i0.png",
  "viewport": { "w": 375, "h": 812 },
  "controls_inventory": "review-375.controls.json",
  "checks": {
    "clipping": {
      "verdict": "MET",
      "evidence": "scrollWidth==clientWidth for ids [3,7,12,18]; truncate explicitly used on id 14 (intentional, see headline-truncation note)"
    },
    "overlap": {
      "verdict": "MET",
      "evidence": "no rect intersection between sticky bar (id 0, y=0..56) and any content rect (min y=72)"
    },
    "double_nav": { "verdict": "MET", "evidence": "single <header> element, single <nav>" },
    "hidden_cta": {
      "verdict": "MET",
      "evidence": "primary CTA id 31 rect.bottom=720 < viewport.h-sticky_footer.h=752"
    },
    "contrast": {
      "verdict": "CANNOT_ASSESS",
      "evidence": "axe-core not run; pixel-sampling not done"
    },
    "alignment_row_peers": {
      "verdict": "UNMET",
      "evidence": "Card row peers declared as ids [10 (handle), 11 (rank), 12 (image), 13 (score), 14 (trash)]. Top edges: 184, 184, 180, 184, 232. id 14 differs by 48 px from the row baseline → ORPHAN."
    },
    "target_size_44": {
      "verdict": "MET",
      "evidence": "all 72 visible interactive rects have w≥44 ∧ h≥44"
    },
    "grid_8pt": {
      "verdict": "UNMET",
      "evidence": "id 14 rect.x=158, x % 8 = 6; id 13 rect.x=160, x % 8 = 0"
    },
    "common_region": {
      "verdict": "UNMET",
      "evidence": "id 14 (trash) bounding container is the card root, but it shares no common-region group with id 11/12/13 (no shared border/background/padding strip)"
    },
    "squint_blur": {
      "verdict": "UNMET",
      "evidence": "blur:6px capture (review-375-card-i0.blur.png) shows a small dark blob at (158, 232) outside any larger block"
    },
    "pairwise_with_i1": {
      "verdict": "MET",
      "evidence": "all 5 declared peers in identical relative positions across i0 and i1"
    }
  },
  "verdict": "UNMET",
  "blocking_findings": ["alignment_row_peers", "grid_8pt", "common_region", "squint_blur"]
}
```

Rules the writer (you, the agent) MUST obey:

- `verdict` at the block level is `UNMET` if **any** check is `UNMET`. There is no "minor" carve-out.
- `evidence` for any non-`CANNOT_ASSESS` check is mandatory and must include rects, mod arithmetic, computed-style values, or quoted text — never adjectives.
- The list of `checks` is closed: if you cannot evaluate one, write `CANNOT_ASSESS` with the reason. Silently dropping a check is a verification failure.

## Step D — Adversarial second pass

After the first pass, re-prompt the model with the screenshots only (verdict block hidden) and this seed:

> "The previous reviewer claims this page is fine. The page contains at least one alignment, grouping, or grid defect. Find it. Output the rect of the offending element and the rect of the row peers it should align with."

Compare the two passes:

- Findings present in only the second pass → re-ground each by rect; if rect math confirms, escalate the original block from `MET` to `UNMET`.
- Findings present in only the first pass → keep, but require the original evidence still verifies.

This mirrors the A/B-swap protocol used in LLM-as-judge research (Evidently, SurePrompts) and the self-play critic pattern (SPC, arXiv 2504.19162). The cost is one extra prompt per route.

## Step E — Squint-test channel

For every component-crop, run:

```js
() => { document.documentElement.style.filter = 'blur(6px)'; }
```

screenshot, then revert. Save as `<crop>.blur.png`. Prompt:

> "List the 3-5 visual blocks visible in this blurred image. Are there any small dark blobs (smaller than ~24 px wide) sitting outside every named block? List their approximate (x,y)."

An orphaned trash icon, a misaligned badge, or a stray FAB all reduce to a "small dark blob outside the block" under blur. Source: NN/g squint test; Polypane operationalization.

## Step F — Reference image when available

If a Storybook story, baseline screenshot from a prior run, or a known-good production URL exists for the same component, capture it and present `[golden, current]` to the model with:

> "These two crops are the same component, golden vs current. List differences as `MOVED | RESIZED | RECOLORED | ADDED | REMOVED` with rect deltas. If a control moved by ≥4 px on either axis, flag it."

Reference-prompted layout-bug detection beat no-context prompting by a wide margin in the canvas-bug paper (arXiv 2501.09236). When no golden exists, skip this step — do not invent one.

## Per-failure-mode definitions

| Check | What `MET` means | What evidence looks like |
|---|---|---|
| `clipping` | No element has `scrollWidth > clientWidth + 1` unless an explicit `truncate`/`line-clamp` is intentional and documented | List of (id, sw, cw); list of intentional truncates |
| `overlap` | No two rects intersect except where one is explicitly a child of the other | Rect-intersection list (empty) |
| `double_nav` | Exactly one top-level `<nav>` and one sticky header | Element count |
| `hidden_cta` | Every primary CTA's rect is inside `(0, 0, vw, vh - sticky_footer.h)` | Rect math |
| `contrast` | Every text node passes WCAG 1.4.3 (4.5:1 for body, 3:1 for ≥18 px or bold ≥14 px) | axe-core or pixel-sample output |
| `alignment_row_peers` | For each declared component, controls in the same logical row share top-edge OR center-line within ε=2 px | Edge list with deltas |
| `target_size_44` | Every visible interactive rect ≥44×44 (or ≥24×24 with WCAG 2.5.8 spacing exception) | Rect list |
| `grid_8pt` | Every component child's `x % 4 === 0 ∧ y % 4 === 0` (or 8, per design system) | Mod-check list |
| `common_region` | Every control belongs to a named visual region (shared background, border, or proximity cluster) | Region map |
| `squint_blur` | No orphan blob smaller than 24 px outside any block in the blur capture | Blur PNG path + (x,y) of any blob, or "none" |
| `pairwise_with_iN` | Same component at index 0 and index ⌊N/2⌋ are layout-identical | Per-control IDENTICAL/DIFFERENT list |

## Anti-patterns the rubric forbids

- "Looks fine" / "Looks good" / "OK across the board" — not values in the schema.
- `MET` for `alignment_row_peers` without listing the row peers' rects.
- `MET` for `clipping` based only on the screenshot — must cite `scrollWidth/clientWidth`.
- `MET` for `target_size_44` without enumerating the rect list (or its length and min(w,h)).
- Treating a single component instance as the only check when ≥2 are present (the model will pick the easiest).
- Performing the form (filling every field) without performing the function (running the underlying queries). The skill harness checks that the cited evidence files exist on disk.
