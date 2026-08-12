---
name: deepen
description: This skill should be used when the user says "/vibe-recall:deepen", "go deep on <repo>", or wants the highest-demand card in the queue promoted from an index-only shallow read to a real feature-level deep card. Reads the target repo's actual source and writes a features[] array back onto its card. The only mutation vibe-recall performs, and it lands in the plugin's own data home, never in a target repo.
---

# vibe-recall deepen

Load skills/guide/SKILL.md first.

**There is no `deepen` engine subcommand.** Reading a repo's real features and deciding
what is worth recording is a judgment call, not a deterministic script -- that is the whole
reason this is a skill and not a `cli.mjs` command. This skill reaches `engine/store.mjs`'s
real exports (`readCards`/`saveCards`) directly; it never references a subcommand that does
not exist.

## 1. Pick the target

```
node engine/cli.mjs queue
```

Prints every non-deep card, ordered by `recallHits` then last-commit recency. Default to the
top entry. If the user named a repo directly, use that instead -- it does not have to be at
the top of the queue, but say so if it isn't on the queue at all (already `deep`, or not
indexed).

## 2. Read the repo, for real

Open the repo's actual source with the Read tool -- entrypoints, the files behind its
`symbols`, its README and CLAUDE.md if present. The shallow card's fields are a place to
start looking, not something to transcribe: a shallow card is index-time metadata, not a
verified description of what the repo does.

## 3. Build the feature entries

For each distinct feature worth recording (a repo can have more than one), capture:

- `name` -- short, specific.
- `files` -- `[{ path, lines }]`, real ranges from what was just read.
- `contract` -- what goes in, what comes out, one line.
- `patterns` -- reusable techniques worth naming.
- `gotchas` -- what a naive copy would get wrong.
- `wouldRedo` -- what would change if this were built again today.

Do not invent a feature that is not in the source, and do not pad the list to look
thorough -- a repo with one real feature worth recording gets one entry.

## 4. Report before writing

List the features found, one line each, before touching the index. Let the user confirm or
trim the list -- a deep card is the highest-trust layer of the index, and nothing belongs
in it because it merely seemed plausible.

## 5. Write the card

Read the current cards, find the one matching this repo, set its `depth` to `"deep"`, and
set its `features` to the confirmed list. Everything else on the card (`path`, `head`,
`deps`, `recallHits`, and so on) stays as it was. Reuse the real store functions rather than
hand-editing the JSON file:

```js
import { readCards, saveCards } from './engine/store.mjs';
const cards = readCards();
const target = cards.find(c => c.repo === '<name>');
target.depth = 'deep';
target.features = [ /* the confirmed entries */ ];
saveCards(cards);
```

`saveCards` is a plain write -- `JSON.stringify` to `cards.json`, no schema check on the way
in. Nothing in the engine validates a card's shape at write time; `schemas/card.schema.json`
is a contract the test suite checks (e.g. `tests/cli.test.mjs` validates every card `:index`
produces against it), not something `saveCards` itself enforces. That makes this skill the
one place responsible for shaping `features` correctly by hand -- a malformed entry here
does not fail loudly, it just becomes bad data the next `:sweep` or `:brief` reads. Run
`node engine/cli.mjs vitals` afterward as a sanity check that the write landed as intended:
`deep cards` goes up by one, `queue depth` goes down by one.

## 6. What this does not do

Deepening writes to vibe-recall's own data home only. It never edits, creates, or deletes
anything inside the target repo -- that would cross into vibe-taker's job, and vibe-recall
does not do it.
