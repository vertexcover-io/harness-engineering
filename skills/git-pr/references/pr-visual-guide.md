# PR visual guide

Adapted from [HumanLayer show-me](https://github.com/humanlayer/skills/blob/main/plugins/visual-pr/skills/visual-pr/references/show-me.md).

Pick the smallest view that helps the reviewer understand the change. Use real names from the
diff, keeping only the calls, fields, files, and boundaries that matter. These are alternative
views to choose from, not a checklist for every PR.

For changed behavior, use concise pseudocode:

```diff
 on(save)
-  write content
+  if content is unchanged
+    return cached result
+  write content
+  invalidate cache
```

For a UI change, show component ownership and important state or hooks:

```diff
 <SessionPage>
   useSessionEvents()
   <SessionToolbar>
+    <RunSkillButton />
   <SessionTimeline>
+    <SkillResultCard />
```

For a refactor, show a shallow file tree with responsibilities:

```diff
 src/
 ├── sessions/
-└── transport.ts
+└── transport/
+    ├── client.ts       # sends API requests
+    └── stream.ts       # consumes session events
```

For runtime behavior, show a call tree or a compact Mermaid diagram when interactions matter:

```text
submitForm
  createSession
    persistPrompt
    launchAgent
  subscribeToEvents
```

For schema or API changes, show the important columns, relationships, or request/response fields.
For a new type, show its complete relevant shape in a language-specific code block. Use a complete
target shape whenever diff notation would hide ownership or execution order. Keep visuals inline
in GitHub Markdown so reviewers can read them directly in the PR.
