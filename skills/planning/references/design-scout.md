# Design scout — the brief

Dispatched from planning step 1, with the code sweep, when the change has a user-facing
surface. Backend-only work never triggers it. The scout collects; it does not interpret.

`TASK_CONTEXT` carries the ticket URL when orchestrate fetched it; a standalone run names the
ticket in the prompt. Read the ticket through the project's tracker reader, the one
orchestrate's setup stage uses.

1. **Collect.** From the ticket's attachments and the design links in its body, save into
   `.harness/<name>/design/`:
   - an HTML mock, as-is, as `design/<slug>/index.html` with the assets it references, so its
     relative links resolve
   - a design spec, as-is, as `design/spec.md`
   - images, as-is, as `design/<slug>.png`

   The mock is readable when its screens' markup is present as text in `index.html`. When the
   body is a loader script and the content sits in encoded payloads, it is not: overwrite
   `index.html` with the page as it stands after its scripts ran, so planning reads markup.
2. **Write `design/INDEX.md`**, one row per image:

   | Screen | Local file | Source | Source of truth for |
   |---|---|---|---|
   | Checkout, empty cart | `design/checkout-empty.png` | ticket attachment | layout, empty-state copy |

   Name the viewport in `Screen` when a screen has more than one frame:
   `Checkout, empty cart — phone 390`. Two viewports are two rows.

**Best-effort.** No tracker configured, token unset, no ticket for this branch, no
attachments: write no INDEX and return one line saying which.

Returns: the INDEX path and one line per surface found.
