---
name: spec-generation
description: "Transforms an approved design doc (from brainstorm) into a structured SPEC with testable acceptance criteria using EARS format. Trigger after brainstorm approval, before planning. Input: design doc path. Output: SPEC.md with requirements, edge cases, and verification matrix."
---

# Spec Generation: Design Doc → Testable SPEC

Reads an approved design document and produces a structured SPEC.md with EARS-formatted requirements, edge cases, and a verification matrix.

**Announce at start:** "Using the spec-generation skill to create a testable SPEC from the design doc."

---

## Input / Output

**Input:** `docs/plans/YYYY-MM-DD-<topic>-design.md` — the approved brainstorm output.

**Output:** `docs/plans/<feature-name>/SPEC.md` — structured specification with testable requirements.

The `<feature-name>` directory is the same one the planning skill will use for phase files.

---

## EARS Format Reference

Use the EARS (Easy Approach to Requirements Syntax) format for all requirements:

| Type | Template | When to Use |
|------|----------|-------------|
| **Ubiquitous** | "The system shall [action]" | Always-on behavior, no trigger needed |
| **Event-driven** | "When [event], the system shall [action]" | Behavior triggered by a specific event |
| **State-driven** | "While [state], the system shall [action]" | Behavior active during a specific state |
| **Unwanted behavior** | "If [condition], then the system shall [action]" | Error handling, edge cases, recovery |

**Key rules:**
- One behavior per requirement — never combine with "and" or "also"
- Use measurable terms — not "quickly" but "within 200ms"
- Avoid ambiguous words: "appropriate", "fast", "user-friendly", "robust", "efficient"

---

## SPEC.md Template

```markdown
# SPEC: <Feature Name>

**Source:** <path to design doc>
**Generated:** <date>

## Requirements

| ID | Type | Requirement | Acceptance Criterion | Priority |
|----|------|-------------|---------------------|----------|
| REQ-001 | Event-driven | When [event], the system shall [action] | [Measurable criterion] | Must |
| REQ-002 | Ubiquitous | The system shall [action] | [Measurable criterion] | Must |
| REQ-003 | Unwanted | If [condition], then the system shall [action] | [Measurable criterion] | Should |

## Edge Cases

| ID | Scenario | Expected Behavior | Derived From |
|----|----------|-------------------|-------------|
| EDGE-001 | [Scenario description] | [What should happen] | REQ-001 |
| EDGE-002 | [Scenario description] | [What should happen] | REQ-002, REQ-003 |

## Verification Matrix

| REQ ID | Unit Test | Integration Test | Manual Test | Notes |
|--------|-----------|-----------------|-------------|-------|
| REQ-001 | Yes | Yes | No | |
| REQ-002 | Yes | No | No | |
| EDGE-001 | Yes | No | No | |

## Out of Scope

- [Explicit list of what this feature does NOT do]
- [Behaviors that might be assumed but are deliberately excluded]
- [Future work that is deferred]
```

---

## Workflow

### Step 1: Read the Design Doc

Read the approved design document at the provided path. Identify:
- Functional behaviors described
- Constraints and non-functional requirements
- Error scenarios mentioned
- Integration points with existing systems

### Step 2: Extract Requirements → EARS Format

For each functional behavior:
1. Classify as Ubiquitous, Event-driven, State-driven, or Unwanted behavior
2. Write in EARS format with a unique ID (REQ-001 through REQ-N)
3. Define a measurable acceptance criterion
4. Assign priority: Must (required for MVP), Should (important but not blocking), Could (nice to have)

### Step 3: Extract Edge Cases

For each requirement, identify edge cases:
1. What happens at boundaries (empty input, max values, concurrent access)?
2. What happens on failure (network down, invalid data, timeout)?
3. What happens in unexpected order (event before initialization, duplicate events)?
4. Assign unique IDs (EDGE-001 through EDGE-N) and link to parent REQ IDs

### Step 4: Build Verification Matrix

For each REQ and EDGE ID:
1. Determine which test types cover it (unit, integration, manual)
2. At least one test type must be marked for every ID
3. Add notes for anything requiring special setup or environment

### Step 5: Write SPEC.md

1. Create the `docs/plans/<feature-name>/` directory if it doesn't exist
2. Write SPEC.md using the template above
3. Verify every REQ ID appears in the verification matrix
4. Verify every EDGE ID links to a valid REQ ID

---

## Quality Criteria

- [ ] Each requirement is independently testable
- [ ] No ambiguous words ("appropriate", "fast", "user-friendly", "robust", "efficient")
- [ ] Acceptance criteria are measurable (counts, exit codes, specific outputs)
- [ ] Every requirement has at least one edge case considered
- [ ] Out of Scope section is non-empty
- [ ] Verification matrix covers every REQ and EDGE ID

---

## Anti-Patterns

- **Implementation details in requirements** — "The system shall use a HashMap" is implementation, not a requirement. Say what, not how.
- **Untestable acceptance criteria** — "The system works correctly" is not testable. Specify observable behavior.
- **Missing edge cases** — If you can't think of an edge case for a requirement, you don't understand the requirement well enough.
- **Combined behaviors** — "The system shall validate input and log errors" is two requirements. Split them.
- **Skipping Out of Scope** — Every feature has things it deliberately doesn't do. Make them explicit to prevent scope creep during implementation.

---

## Integration Notes

- **Planning** reads the SPEC to map plan phases to specific REQ IDs. Each phase should cover a coherent set of requirements.
- **TDD** generates tests per REQ ID and EDGE ID. Test names should reference the ID they cover (e.g., `test_REQ_003_event_triggers_action`).
- **Code Review** validates completeness against the verification matrix — every REQ/EDGE with a test type marked must have a corresponding test.
