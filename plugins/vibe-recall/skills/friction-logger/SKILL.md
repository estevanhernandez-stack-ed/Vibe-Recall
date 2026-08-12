---
name: friction-logger
description: Internal placeholder (v0.1) -- reserved friction-event contract. Command skills name their trigger codes here; a later version implements the writes.
---

# friction-logger (v0.1 placeholder)

Reserved path: `<data home>/friction.jsonl` (append-only), same resolution as
session-logger. Entry `{ timestamp, sessionUUID, command, trigger, confidence, context }`.

Trigger catalog (confidence fixed per code):

- `wall-bypass-attempt` (high) -- should be structurally impossible; if it ever fires, the
  guard broke, not the config.
- `diverged-pair-ignored` (medium) -- a sweep or brief ran against a diverged card without
  the pair being resolved.
- `foreign-false-positive` (medium) -- a user corrected a `foreign` classification via
  `authors`.
- `zero-hit-surprising` (low) -- a sweep came back empty on something the user expected to
  find.
- `index-relied-on-without-refresh` (medium) -- a sweep or brief ran against an index the
  user acknowledged as old without running `:index` first.
- `shallow-remote-brief-limited` (low) -- a brief hit the not-on-this-machine case.
- `gh-unauthenticated` (low) -- remote-only enumeration silently skipped because `gh` was
  absent or unauthenticated.

v0.1 writes nothing; the contract exists so a later version doesn't have to break the
format.
