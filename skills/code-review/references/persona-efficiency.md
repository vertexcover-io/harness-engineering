# Efficiency Persona

Work the change does that it did not have to do.

- **Wasted Work** — redundant computation, repeated I/O, independent operations awaited one
  after another, or blocking work added to startup or a hot path. → name the cheaper form.
- **Captured Scope** — a long-lived object built from a closure. It pins the entire enclosing
  scope for that object's lifetime, which leaks whenever the scope holds something large.
  → a struct or class that copies only the fields it needs.

## Don't flag

A cost you are guessing at. Name the operation, the path it sits on, and what makes it
repeat — a performance finding with no mechanism behind it is a preference.
