---
name: router
description: This skill should be used when the user says "/vibe-recall" (bare, no subcommand), "what should I recall next", "where's my index at", or wants vibe-recall to pick the next move. Reads config and index state and recommends one next command. Never auto-fires index or any other command.
---

# vibe-recall router

Load skills/guide/SKILL.md first. Then check state, in order, first match wins:

1. **No config yet** -- no `config.json` at the resolved data home (see
   `engine/datahome.mjs`) -> first run. Invoke the first-run-setup skill, then recommend
   `/vibe-recall:index`.
2. **Config exists but no cards yet** -- `cards.json` empty or absent -> recommend
   `/vibe-recall:index`. Name roughly what it costs (a `git` pass over every local repo in
   the estate) so the size of the wait isn't a surprise.
3. **Cards exist** -- read the situation rather than guessing:
   - Speccing something new, or the user asked "have I built this" -> recommend
     `/vibe-recall:sweep <phrase or spec path>`.
   - A sweep just ran and a hit looks worth trusting -> recommend `/vibe-recall:brief <repo>`.
   - The user asked about index health, or a `foreign` classification looks wrong ->
     recommend `/vibe-recall:vitals`.
   - No specific ask -> run `node engine/cli.mjs vitals` yourself and lead with the
     numbers: repos indexed, deep cards, queue depth, diverged pairs, any foreign repos by
     name. Nonzero diverged pairs get said first -- an unresolved pair is silently eating a
     ranking slot every sweep since it appeared. Nonzero queue depth alongside real
     `recallHits` on shallow cards is the cue to recommend `/vibe-recall:deepen`.

`/vibe-recall:index` is never fired automatically, even against an index that looks stale
-- it is a real cost across the whole estate, and refreshing it is the user's call, not the
router's. If the index looks old, say so and let the user decide.
