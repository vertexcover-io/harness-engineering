# Tech-debt manifest mode

`INPUT_KIND=findings` means `INPUT_PATH` is a `findings.json` from `tech-debt-finder`. The script
detects it by shape, not by filename.

Read the manifest directly. Do not summarise it into prose first.

Then follow `tech-debt-finder/references/auto-fix-handoff.md`:

- Fix only the findings marked `auto_fixable: true`.
- Before stage 6, write `fix-manifest.json`. Give every finding one terminal disposition:
  `fixed`, `issue`, `suppressed`, or `dropped`. A `dropped` finding needs a reason.
- A dropped `auto_fixable` finding with no reason blocks the commit.
- Put the disposition table in the commit body and the pull request body.

Append one `problem` event per finding you fix, and one `resolution` when it is done. The ledger
then counts them, so the fix manifest and the run agree by construction.
