---
name: find-factors
description: Identify the factors that change an existing product flow's behavior or outcome. Use when a user wants to understand what influences a flow; inspect the implementation and present the full factor list within the agreed scope.
---

# Find factors

Identify and explain the factors that change a product flow's behavior or outcome. A factor is an input, setting, state, product concept, or condition whose variation changes how the flow behaves or what result it produces.

## 1. Establish scope

**Target:** Establish the flow and boundaries from the conversation. Clarify ambiguous scope and agree material scope changes with the user.

**Context:** Identify the starting project, inspected versions, and relevant existing scenarios or tests. Follow the implementation across the layers and dependencies that determine the flow's behaviour within scope.

**Evidence:** Use current behaviour as the baseline. Distinguish findings from code, observed execution, and user-confirmed requirements. Surface conflicts between requirements and implementation for confirmation. Keep unanswered questions and inaccessible evidence marked as unresolved.

## 2. Discover the full factor list

**Discovery:** Inspect the flow's entry points, implementation, and shared configuration to identify all factors found within the agreed scope. Trace conditions that change available fields and actions, required inputs, validation, access, calculations, processing, or outcomes.

**Inventory:** Keep investigation notes linking each discovered condition to its factor, source, affected behaviour, and investigation status. Complete this discovery when each inspected behaviour-changing condition belongs to a factor and each evidence gap is recorded.

**Presentation:** Present all factors found within scope together in chat as a numbered, flat list. Give each a readable name and a description following the guidance below. State any evidence gaps that limit the list's completeness.

**Factor descriptions:** Use a short paragraph of connected sentences: explain what the user does or encounters, how this factor changes the flow, and why that changes the result. Use familiar product language and make the cause and effect clear enough for Product and QA to understand the factor's impact.
