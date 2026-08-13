# Design scout — the brief

Dispatched from step 1, alongside the code sweep, when the change has a **user-facing surface**.
Backend-only work — a webhook, a job, a schema migration — never triggers it.

This scout's job is to put every design asset on disk, where the plan can point at it. It
collects; it does not interpret.

Resolve the branch to its tracker ticket **by the rule the project already documents** (the
tracker, the branch→ticket mapping, and the token env var, as
`../../functional-verify/references/publish.md` sets out). Then collect, from the ticket's
attachments and any design links in its body:

- **Screenshots and images** — saved as-is
- **HTML mockups** — saved as-is, with any assets they reference
- **Figma frames** — exported to PNG through the Figma MCP, one file per frame

Images and exported frames land directly in `.harness/<name>/design/`. An HTML mockup keeps its
own folder — `design/<slug>/index.html` beside the assets it references — so its relative links
resolve without rewriting the document. `design/INDEX.md` sits alongside:

| Screen | Local file | Source | Source of truth for |
|---|---|---|---|
| Checkout, empty cart | `design/checkout-empty.png` | Figma `…/node-id=41:88` | layout, empty-state copy |

**Best-effort, exactly like publish.** No tracker configured, token unset, no ticket for this
branch, no attachments — write no INDEX and return one line saying which. A missing design is a
fact the plan can act on; a stalled scout is not.

Returns to the conversation: the INDEX path and one line per surface found.
