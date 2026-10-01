# Changelog

All notable changes to vibe-recall are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The plugin ships from `plugins/vibe-recall/` and carries a copy of this file.

## [0.1.2] — 2026-10-01

Version-pair fix, no behavior change. The v0.1.1 tag shipped with `plugin.json` and `package.json` still reading 0.1.0, so the installed plugin reported the wrong version. Both now read 0.1.2 and the pair stays in lockstep from here. First marketplace registration (vibe-plugins stable channel).

## [0.1.1] — 2026-08-12

The initial release as tagged. Same content as the 0.1.0 entry below; the tag and the manifest disagreed, which 0.1.2 corrects.

## [0.1.0] — 2026-08-12

Initial release. Indexes a developer's own git repos and surfaces prior art while
they spec a new feature.

### Added

- **`index`** — walks a configured estate root (depth-bounded), builds a shallow
  card per in-scope repo: symbol names, dependency names, entrypoint paths, and
  short claim/gotcha strings pulled from README/CLAUDE.md. Never a file body.
  Skips any file that is `.env`-shaped by name or trips a secret-shape scan by
  content. Prints diverged clone pairs (same remote, different HEAD) for the user
  to resolve.
- **Tenant walls.** A configured wall (nothing ships pre-seeded — configured in
  first-run-setup, unioned in at every load, never silently dropped) is never
  indexed, never ranked, never named anywhere the index writes. Enforced at a
  single choke-point (`assertNoWalled`) that every producer of indexed records
  passes through, local or remote.
- **Duplicate-clone collapse.** Two clones sharing a normalized remote collapse to
  one canonical card by most-recent commit; the other becomes a named sibling.
  Diverged (different HEAD) pairs are flagged rather than silently resolved.
- **Fork / vendored-checkout filter.** `classifyProvenance` reads authorship ratio
  from git history (own commits ÷ total commits, `--all`-scoped) against a
  calibrated 0.75 floor. A repo below the floor is classified `foreign` and
  excluded from ranking by default. Fails open on missing or unreadable identity
  data — "not classifiable" is never read as "foreign."
- **`sweep <phrase>`** — ranks indexed cards against a query with deterministic,
  self-explaining scoring: code-derived fields (symbols, entrypoints) outrank
  prose-derived ones (gotchas, claims), each term weighted by inverse document
  frequency across the card set, and every hit carries a `why` line naming which
  fields and terms fired. Honest zero-hit: "No prior art in your estate for X" is
  a real answer, not softened into a weak match. Excludes `foreign`-classified
  cards and the repo the sweep is run from by default (`--include-foreign`,
  `--include-self` opt back in); a rerun notice only claims what a literal rerun
  with the named flag would actually surface.
- **`queue`** — the demand-ranked deepen queue: every non-`deep` card, ordered by
  recall-hit count then last-commit recency.
- **`vitals`** — coverage and hygiene report: repos indexed, deep cards, queue
  depth, diverged pairs, foreign repos (named, not just counted), scan-truncated
  count, secret-file skip count.
- **`/vibe-recall:brief <repo>`** — re-reads the named hit live, at its current
  HEAD, and hands off to `vibe-taker`. The only surface allowed to author a claim
  about source; a card is a lead, never a citation.
- **`/vibe-recall:deepen [repo]`** — promotes the highest-demand card in the queue
  from `shallow` to `deep` by reading its real source and recording actual
  features. Writes only to vibe-recall's own data home, never to a target repo.
- **`UserPromptSubmit` hook** — a budget-bounded banner that fires on detected
  build intent, reads the index, and surfaces up to three hits (or a stale-index /
  no-index notice) without ever blocking the prompt or crashing the session on a
  malformed card.
- **Central, depth-independent data home.** Cards and config live at
  `${CLAUDE_PLUGIN_DATA}`, else `~/.claude/plugins/data/vibe-recall/`, else a loud
  failure — never written into an indexed repo. UNC network paths are refused
  rather than silently mis-resolved.
- **Skills and commands layer**: `guide`, `router`, `first-run-setup`, `sweep`,
  `brief`, `deepen`, `vitals`, `session-logger`, `friction-logger`, with a
  contract test suite (`tests/skills-contract.test.mjs`) enforcing frontmatter
  presence, the live-verification rule's verbatim wording, the absence of
  invented flags or subcommands, and no emoji.
- **`docs/cart-seam.md`** — a proposal (not a change) for how
  `vibe-cartographer`'s `:spec` and `:checklist` could optionally call `:sweep`
  through that plugin's own existing composition framework, skipping silently
  when vibe-recall is not installed.

### Validated

Round-tripped against the real estate (~90 local repos) before tagging: `vitals`'s
reported repo count matched an independently counted in-scope total exactly; a
literal search of the written `cards.json` turned up no walled path; `sweep
"stripe checkout"` surfaced real, hand-verified code evidence (a live/test
Stripe-key mismatch detector and a purchase-return dedup guard) in a repo other
than the one being worked in. Full results in `README.md` § "Real-estate
validation."

### Known limits

No public/open-source code search, no comparative briefs across multiple hits, no
cross-machine index sync, no automatic planting, and one known fork-filter false
positive (a genuinely-own repo split across two git identities where the
alternate never repeats across a second repo) with a documented correction path.
See `README.md` § "Known limits" for detail.
