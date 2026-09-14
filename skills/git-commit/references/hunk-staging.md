# Hunk-Level Staging

Use this when one file holds changes for more than one commit.

## Stage selected hunks

Save the file's diff, delete the hunks that belong to a later commit, and apply what is left to
the index only:

```bash
patch_dir="$(mktemp -d)"
git diff -- "$FILE" > "$patch_dir/hunks.patch"

# Edit hunks.patch: keep the header lines (diff --git, ---, +++) and the @@ blocks for this
# commit; delete the other @@ blocks whole.

git apply --cached "$patch_dir/hunks.patch"
```

`git apply --cached` leaves the working tree untouched, so the hunks you removed stay unstaged for
the next commit.

## Verify

```bash
git diff --cached -- "$FILE"   # only this commit's hunks
git diff -- "$FILE"            # the rest, still unstaged
```

## When the split gets complicated

Two hunks that overlap, or one hunk mixing both concerns, cannot be split by deleting blocks. Commit
the whole file under its main concern.
