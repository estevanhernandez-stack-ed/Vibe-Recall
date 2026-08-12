---
name: sweep
description: This skill should be used when the user says "/vibe-recall:sweep <phrase|spec path>", "have I built this before", "find prior art for X", or wants to mine the estate for a capability before speccing it fresh. Ranks indexed cards against the query and reports hits with their evidence, honestly reporting zero hits when there are none. Read-only -- no source mutation, no writes to any target repo.
---

# vibe-recall sweep

Load skills/guide/SKILL.md first. Requires an index -- if `cards.json` is empty or absent,
say so and hand off to `/vibe-recall:index` rather than sweeping nothing.

## 1. Resolve the query

The argument is either a short phrase (`"stripe checkout"`) or a path to a spec/PRD file in
the current repo. For a file path: read it and pull out the capability-bearing phrases --
feature names, third-party services, domain terms -- not section headers or boilerplate.
Run one sweep per distinct capability phrase rather than mashing the whole document into a
single query; a spec covers several capabilities, and mashing them dilutes every term's
rarity, which is the signal the ranking actually depends on.

## 2. Check home first

Before mining the estate: **the current repo can already contain what the spec is asking
for.** A spec can read as pre-build while the repo it lives in has substantially implemented
it already -- a real case in the hand-run: a spec listed open issues that "block build
start" while its `src/` held the finished implementation. Grep the current repo's own
source for the capability phrase(s) before ranking anywhere else. A real hit here gets said
first and plainly -- "you have already built this here," with the files found -- before
naming any other repo. This does not replace the estate sweep; it runs before it.

## 3. Run the sweep

```
node engine/cli.mjs sweep <phrase>
```

For a multi-phrase spec sweep, run it once per phrase and merge, de-duplicating by repo and
keeping each repo's strongest hit. The CLI already ranks, bumps `recallHits` on every card
it returns, excludes `foreign` cards, and excludes the repo you're running the sweep from --
do not re-implement any of that by hand.

Self-exclusion is automatic and requires no argument: the CLI works out which indexed repo
you're standing in from `cwd` and drops it from the ranking, the same way it always drops
`foreign` cards. Only 10 hits print. When the exclusion actually cost the visible list
something -- the excluded card would have landed in that top 10 on a rerun, not just
somewhere in the full ranked set -- it says so on its own: `(excluded: <repo>, the repo
you're in -- rerun with --include-self to see it)`, or the equivalent line naming a
foreign-repo count. The promise in that line is literal: a rerun with the named flag will
put it in front of you. Read the line if it's there; its absence on a full 10-hit list does
not mean nothing was excluded, only that nothing excluded would have made the cut anyway.

Two opt-in flags, both real, both taking no value:
- `--include-self` -- re-admits the current repo into its own results (looking for an
  earlier attempt at the same thing, in the same place).
- `--include-foreign` -- re-admits `foreign`-classified cards (auditing what the fork filter
  caught, or double-checking a suspected false positive before editing `authors`).

Being in a repo also lifts its `deps` into the ranking as stack affinity -- a card sharing a
dependency with the repo you're in ranks above one that doesn't, all else equal. This falls
out of the same cwd-to-card match that drives self-exclusion; nothing extra to invoke.

## 4. Report

Zero hits: print the CLI's own line verbatim (`No prior art in your estate for "<query>".
Build it fresh.`) -- do not soften it into a maybe-match. This is the product's honest
answer, not an error.

Hits: list each with repo, depth, and the `why` evidence the CLI already printed. Call out
plainly:
- a `deep` card versus a `shallow` one -- deep means a human has already read this repo's
  features; shallow means index-only.
- a hit whose evidence is documentation-only (the `why` line will say "documentation only,
  no code evidence") -- a lead, not proven prior art.
- a `DIVERGED` flag -- two clones of the same remote disagree; name both and say which copy
  needs resolving before anyone trusts it.
- a `shallow-remote` hit -- not on this machine; carries only what the GitHub API showed
  when `:index` last ran.

## 5. Hand off

Recommend `/vibe-recall:brief <repo>` on the strongest hit for a verified writeup, or
`/vibe-recall:deepen` if the top hits are all shallow and worth a closer look before
briefing.
