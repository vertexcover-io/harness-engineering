# ADRs — recording decisions that outlive the conversation

An ADR is a permanent, project-facing record of one architectural decision. ADRs live in
`docs/adr/` at the **project's** repo root (never in the harness repo), numbered
sequentially: `0001-slug.md`, `0002-slug.md`. Create `docs/adr/` lazily — only when the
first ADR is needed. To number: scan `docs/adr/` for the highest existing number and
increment by one.

## Template

```markdown
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

That's it. An ADR can be a single paragraph. The value is in recording *that* a decision
was made and *why*, not in filling out sections.

Optional sections — include only when they add genuine value; most ADRs need none:

- **Status** frontmatter (`proposed | accepted | deprecated | superseded by ADR-NNNN`):
  useful when decisions get revisited.
- **Considered Options**: only when the rejected alternatives are worth remembering. From
  planning, step 3's approaches and design.md's `Instead of` column are the source.
- **Consequences**: only when non-obvious downstream effects need calling out.

## The three gates — all must hold

1. **Hard to reverse**: the cost of changing your mind later is meaningful.
2. **Surprising without context**: a future reader will look at the code and wonder "why
   on earth did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives and one was picked
   for specific reasons.

Easy to reverse → skip it; you'll just reverse it. Not surprising → nobody will wonder
why. No real alternative → nothing to record beyond "we did the obvious thing."

## What qualifies

- **Architectural shape.** "We're using a monorepo." "The write model is event-sourced,
  the read model is projected into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing communicate via domain
  events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth provider,
  deployment target — not every library, just the ones that would take a quarter to swap.
- **Boundary and scope decisions.** "Customer data is owned by the Customer context; other
  contexts reference it by ID only." The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** "Manual SQL instead of an ORM because
  X." Anything a reasonable reader would assume the opposite of — these stop the next
  engineer from "fixing" something that was deliberate.
- **Constraints not visible in the code.** "We can't use AWS because of compliance."
  "Response times under 200ms because of the partner API contract."
- **Non-obvious rejections.** Considered GraphQL, picked REST for subtle reasons — record
  it, or someone suggests GraphQL again in six months.
