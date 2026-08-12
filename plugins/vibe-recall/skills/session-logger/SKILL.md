---
name: session-logger
description: Internal placeholder (v0.1) -- reserved logging contract for vibe-recall sessions. Command skills reference it at start and end; documents the format so the data home is stable once implemented.
---

# session-logger (v0.1 placeholder)

Reserved path: `<data home>/sessions.jsonl` (append-only), where `<data home>` resolves per
`engine/datahome.mjs` (`${CLAUDE_PLUGIN_DATA}`, else `~/.claude/plugins/data/vibe-recall/`).

Entry shape, two-phase per session:
start `{ sessionUUID, timestamp, command, outcome: "in_progress" }` /
end `{ sessionUUID, timestamp, command, outcome: completed|aborted|error, durationMs,
summary: { hits, cardsTouched, foreignFlagged, briefsWritten } }`.

Never log a card's `symbols`/`claims`/`gotchas` content, a repo's file paths beyond its
name, or anything read from inside a target repo -- the invariant that cards store shapes
and never content applies to this log too. v0.1 writes nothing; the contract exists so a
later version doesn't have to break the format.
