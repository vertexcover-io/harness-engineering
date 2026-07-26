# PRD: Saved Searches

## Overview
Users can save a search query with a name and re-run it from a dropdown.

## Requirements
- SS-1: A logged-in user can save the current search (query text + active filters) under a name.
- SS-2: Saved searches appear in a dropdown on the search page, most recently used first.
- SS-3: Selecting a saved search re-runs it immediately.
- SS-4: A user can delete a saved search.

## Out of scope
- Sharing saved searches between users.

<!-- Deliberate gaps a good grill must surface:
     no limit on saved searches per user, no rename/update flow,
     no behavior when a saved filter references a deleted entity,
     no non-functional target (dropdown load time, max query size),
     no statement of what happens on duplicate names. -->
