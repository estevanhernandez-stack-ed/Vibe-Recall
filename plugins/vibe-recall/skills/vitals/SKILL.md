---
name: vitals
description: This skill should be used when the user says "/vibe-recall:vitals", "is the index healthy", "how much of my estate is indexed", or wants coverage and health signal on the plugin's own index. Shells to the engine and interprets the numbers -- read-only, no mutation.
---

# vibe-recall vitals

Load skills/guide/SKILL.md first.

```
node engine/cli.mjs vitals
```

Prints, in order: repos indexed, deep cards, queue depth, diverged pairs, foreign repos
(count, then each one named), scan truncated, secret-file skips, deps present. Read every
line, not just the first one:

- **repos indexed / deep cards / queue depth** -- coverage. A queue depth close to the repo
  count with zero deep cards is expected right after a first `:index`, not a problem to fix.
- **diverged pairs** -- nonzero means two clones of the same remote disagree and neither was
  picked as canonical. Name them (`:index`'s own run already did, if this is what surfaced
  it) and tell the user to resolve which copy is home base before trusting either in a
  brief.
- **foreign repos** -- named, not just counted, because naming is how a false positive gets
  caught. A repo classified `foreign` is excluded from every sweep's ranking by default. If
  one of the named repos is genuinely the user's own work committed under an unrecognized
  git identity, the fix is adding that identity to `authors` in `config.json`
  (`engine/corpus.mjs`'s `enumerateLocal` unions configured authors with the identities it
  discovers across the estate on every `:index` run -- it can only add, never remove a
  discovered identity) and re-running `:index`. Do not suggest editing the
  card by hand: provenance is recomputed from git history on every index run, and a
  hand-edited card would just be overwritten on the next one.
- **scan truncated** -- nonzero means at least one repo's code walk hit a file-count or
  file-size cap and stopped early; that repo's `deps`/`symbols`/`entrypoints` are a partial
  picture, not a complete one. Not an error, a caveat worth naming if that repo turns up in
  a sweep.
- **secret-file skips** -- files that contributed nothing to the index because they looked
  `.env`-shaped by name, or a line inside them looked secret-shaped by content. A high
  number here is the index working as designed, not a defect.

- **deps present** -- `yes` when the engine's one runtime dependency (`ajv`) resolves from
  the installed plugin directory. `NO` means the install-time `npm ci` did not run (no npm on
  PATH, offline, or it timed out): the hook keeps working but `:index` and `:sweep` will stop
  with the same message. The fix is the one printed on the line: `npm ci --omit=dev` inside
  `plugins/vibe-recall/` of the installed plugin, then retry.

This reports on the plugin's own index, not on any one target repo -- there is nothing here
to fix by editing a target's source.

**Staleness is not one of these lines.** This command reports coverage and hygiene, not
age. Time-based staleness (comparing `indexedAt` against a configurable threshold) lives in
the hook path (`engine/banner.mjs`'s `isStale`); HEAD-based staleness is checked live by
`:sweep` and `:brief` when they run. If these numbers look old, the fix is
`/vibe-recall:index`, not a change to this skill's output.
