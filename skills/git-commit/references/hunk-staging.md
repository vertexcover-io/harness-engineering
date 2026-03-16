# Hunk-Level Staging Techniques

When you need to stage specific hunks from a file (not the whole file), use these approaches.

## Simple Case: Few Hunks, Clear Boundaries

Save the full diff, filter it to keep only desired hunks, and apply:

```bash
# 1. Save full diff for the file
git diff <file> > /tmp/file.patch

# 2. Edit the patch to keep only desired @@ blocks
#    Keep the diff header lines (--- a/file, +++ b/file)
#    Remove unwanted @@ hunk sections entirely

# 3. Apply filtered patch to staging area only
git apply --cached /tmp/file_filtered.patch

# 4. Verify
git diff --cached <file>   # only intended changes are staged
git diff <file>            # remaining changes still in working tree
```

## Using Python for Patch Filtering

For programmatic hunk selection:

```python
import subprocess, re

def stage_hunks(filepath, keep_indices):
    """Stage specific hunks (0-indexed) from a file's diff."""
    diff = subprocess.check_output(['git', 'diff', filepath]).decode()
    lines = diff.split('\n')

    # Find hunk boundaries
    hunk_starts = [i for i, l in enumerate(lines) if l.startswith('@@')]

    # Build filtered patch: header + selected hunks
    header = lines[:hunk_starts[0]] if hunk_starts else []
    selected = []
    for idx in keep_indices:
        start = hunk_starts[idx]
        end = hunk_starts[idx + 1] if idx + 1 < len(hunk_starts) else len(lines)
        selected.extend(lines[start:end])

    patch = '\n'.join(header + selected) + '\n'

    proc = subprocess.run(
        ['git', 'apply', '--cached', '-'],
        input=patch.encode(), capture_output=True
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode())
```

## When to Use Hunk Staging

Most of the time, all changes in a file belong to one commit. Only reach for hunk-level staging when a file genuinely has mixed concerns — e.g., one hunk adds a feature and another fixes an unrelated bug.

If hunk splitting gets complicated, it's often better to ask the user whether to commit the whole file together under whichever concern is dominant.

## Verification

Always verify after staging:

```bash
git diff --cached <file>  # confirm staged content
git diff <file>           # confirm unstaged remainder
```
