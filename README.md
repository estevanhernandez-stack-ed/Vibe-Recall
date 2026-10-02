# Vibe Recall

Indexes a developer's own git repos and surfaces prior art while they spec a new
feature. Answers one question: *have I already built something like this?*

## What it does

Vibe Recall walks a configured estate root, builds a shallow "card" per in-scope repo
(symbol names, dependency names, entrypoint paths, short claim/gotcha strings pulled
from README/CLAUDE.md — never a file body), and ranks those cards against a phrase or a
spec file when you sweep for prior art. It never writes code, and it never edits
anything inside a repo it indexes. When a hit looks real, it hands off to
`/vibe-recall:brief` for a verified writeup and then to `vibe-taker` to actually move
code — vibe-recall's own job ends at the recommendation.

## Install

**Stable — as a Claude Code plugin via the marketplace:**

```text
/plugin marketplace add estevanhernandez-stack-ed/vibe-plugins
/plugin install vibe-recall@vibe-plugins
```

**Canary — track this repo's `main`:**

```text
/plugin install vibe-recall@estevanhernandez-stack-ed/vibe-recall
```

First use with no config runs `/vibe-recall:first-run-setup` (or triggers
automatically the first time a command needs one): estate root, optional GitHub
accounts for remote-only listing, tenant walls (nothing ships pre-seeded — you
configure your own, e.g. an employer directory name, and once set a wall is never
silently dropped), and any extra excluded path segments.

## Commands

Four real subcommands exist in the engine (`node engine/cli.mjs <word>`, run from
`plugins/vibe-recall/`):

| Command | Does |
|---|---|
| `index` | Walks the estate, builds or refreshes a shallow card per in-scope repo, prints any diverged clone pairs. |
| `sweep <phrase>` | Ranks indexed cards against a query. Honest zero-hit. Excludes `foreign`-classified cards and the repo you're standing in by default (`--include-foreign`, `--include-self` to opt back in). |
| `queue` | The demand-ranked deepen queue — every non-deep card, ordered by recall hits then last-commit recency. |
| `vitals` | Coverage and hygiene: repos indexed, deep cards, queue depth, diverged pairs, foreign repos (named), scan-truncated count, secret-file skips. |

A fifth engine entry point, `banner`, is not a user-facing command — it's the
`UserPromptSubmit` hook's own entry point (also reachable directly via
`engine/hook.mjs`), exposed on the CLI only for manual testing.

Everything else is a skill, not a deterministic script, because the work is a judgment
call rather than something a script can decide on its own:

| Skill | Does |
|---|---|
| `/vibe-recall` (bare) | Router — reads config/index state, recommends one next command. Never fires `index` or anything mutating on its own. |
| `/vibe-recall:sweep <phrase\|spec-path>` | Wraps the `sweep` subcommand: resolves a phrase or spec file into capability queries, checks the current repo's own source first, reports hits with their evidence. |
| `/vibe-recall:brief <repo>` | Re-reads the named hit live, at its current HEAD, and hands off to `vibe-taker`. The only skill allowed to author a claim about source — there is no `brief` engine subcommand, because deciding what's worth citing is not deterministic. |
| `/vibe-recall:deepen [repo]` | Reads a repo's actual source and promotes its card from `shallow` to `deep`, recording real features. There is no `deepen` engine subcommand for the same reason as `brief`. |
| `/vibe-recall:vitals` | Runs and interprets the `vitals` subcommand's output. |

## The invariants

Every skill in this plugin is built against these. They are not preferences to weigh
against convenience.

- **Walls are refusals, not preferences.** A path under a configured tenant wall
  (you set these yourself in first-run-setup — nothing ships pre-seeded — and once
  configured a wall is unioned in at every load and never silently dropped) is
  never indexed, never ranked, never named anywhere the index writes. There is no
  override flag. If a wall looks wrong, the fix is the config, not routing around
  the guard.
- **Cards store shapes, never content.** A card holds symbol names, dependency
  names, file paths, and short claim strings — never a file body, an `.env` value,
  or anything a secret-shape scan flagged on the way in. The index is a map of the
  estate, not a mirror of it.
- **The index can suggest, only a live read can claim.** A card is a snapshot from
  whenever `index` last ran. Good enough to rank, good enough to point at, never good
  enough to quote. Only `/vibe-recall:brief` is allowed to author a claim about
  source, and it does so by opening the file again, in the current session, at the
  repo's current HEAD.
- **Zero hits is a real answer.** "No prior art in your estate for X" is the
  product's honest answer, not a failure mode to soften into a weak match.

## Real-estate validation (v0.1 gate)

Run against roughly 90 local repos before tagging, not a synthetic fixture:

- `vitals` reported 83 indexed repos. Independently counted: 91 git repos under the
  estate root after excluding the configured wall (referred to here as `Acme`) and
  underscore-prefixed directories, then 83 after collapsing 7 duplicate-clone groups
  (15 raw entries sharing a normalized remote) down to their canonical copies — an
  exact match against what the tool reported, not just "within 5."
  - The fork/vendored-checkout filter classified exactly the two known cases
    `foreign` — see "Known limits" below for the one accepted false positive.
- A literal search of the written `cards.json` (12,772 lines) turned up no card
  whose `path` or `repo` field carries the walled `Acme` segment. The wall name
  does appear as ordinary prose in a handful of unrelated repos' README/CLAUDE.md
  files (unrelated business-domain content in personal, non-walled projects) —
  that is expected and is not a wall breach.
- `sweep "stripe checkout"` surfaced real code evidence — `computeStripeVerdict`,
  `trackBeginCheckout`, `flushCheckoutReturn` — in a repo other than the one being
  worked in, including a live/test Stripe key mismatch detector and a
  purchase-return dedup guard that would plausibly change how a new checkout flow
  gets built.
- The top hit's cited paths were opened and hand-verified against real source
  before this was written up as a pass, not trusted from the card.

## Known limits (v0.1)

- **One runtime dependency, installed at plugin-install time.** Claude Code runs `npm ci`
  in the plugin directory when it installs the plugin; if that step did not happen (no npm
  on PATH, offline, timeout) the prompt hook still works and every command stops with a
  message naming the fix. `/vibe-recall:vitals` reports it as `deps present NO`.
- **No public or open-source code search.** The index only ever walks the
  configured estate root. It has no notion of anyone's code but the estate owner's.
- **No comparative briefs across multiple hits.** `/vibe-recall:brief` verifies one
  named repo at a time; there is no ranked side-by-side writeup across several
  candidates in one pass.
- **No cross-machine index sync.** Cards and config live under one machine's local
  data home (`${CLAUDE_PLUGIN_DATA}` or `~/.claude/plugins/data/vibe-recall/`).
  Two machines mean two independent indexes with no reconciliation between them.
- **No automatic planting.** vibe-recall never writes to a target repo. Every hit
  ends at a recommendation and a `vibe-taker` handoff the user runs themselves.
- **The fork filter has one known false positive**, found on the real estate:
  a repo that is entirely the owner's own work, but split across two git identities
  (the usual name plus a repo-specific alternate) where the alternate never repeats
  across a second repo. Identity discovery only recognizes an identity as "the
  owner" once it appears in two or more repos (a flat floor, calibrated against the
  same real estate — see `engine/corpus.mjs`'s comment on `minEstateRepos`), so a
  one-off alternate identity's commits don't count toward authorship and the ratio
  can drop below the 0.75 threshold. **To correct it:** add the alternate identity
  to `authors` in `config.json` and re-run `index` — `vitals` names every
  `foreign`-classified repo for exactly this reason. Do not hand-edit a card;
  provenance is recomputed from git history on every index run and a hand-edited
  value would be overwritten on the next one.

## Cart seam

`docs/cart-seam.md` proposes an optional composition point where
`vibe-cartographer`'s `:spec` and `:checklist` call `vibe-recall:sweep` when it's
installed, and skip silently when it isn't. It is a proposal to that plugin's
maintainers — nothing in `vibe-cartographer` is changed by this repo, and nothing
here depends on it being accepted.

## Data home

Cards and config live centrally, never inside an indexed repo:
`${CLAUDE_PLUGIN_DATA}`, else `~/.claude/plugins/data/vibe-recall/`, else a loud
failure rather than a silent write to the wrong place (`engine/datahome.mjs`).

## Part of the Vibe ecosystem

Part of the **[Vibe Plugins](https://github.com/estevanhernandez-stack-ed/vibe-plugins)**
marketplace from 626 Labs.

```text
/plugin marketplace add estevanhernandez-stack-ed/vibe-plugins
```

## License

MIT
