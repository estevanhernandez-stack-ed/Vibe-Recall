# Cart seam: an optional `vibe-recall` composition point

**Status: proposal, not a change.** Nothing in `vibe-cartographer` is edited by this
document. It describes a row that could be added to that plugin's own composition
framework, for `vibe-cartographer`'s maintainers to accept, reject, or amend on their
own promotion cycle. Read alongside `vibe-cartographer`'s
`plugins/vibe-cartographer/skills/guide/SKILL.md` §"Ecosystem-Aware Composition"
(lines 209-263 as of this writing) and its `docs/self-evolving-plugins-framework.md`
Pattern #13 — this proposal does not invent a new mechanism, it fills in a new row
of a mechanism that already exists and already ships.

## Why this and not a hard dependency

`vibe-recall` answers one question: *have I already built something like this?* That
question is most valuable at exactly two moments in Cart's flow — architecting a new
component (`/spec`) and sequencing it into build items (`/checklist`) — because those
are the two points where a wrong assumption ("this doesn't exist yet, build it fresh")
gets baked into an artifact the builder will act on. Cart already has a name for this
shape of integration: Pattern #13, Layer 1, "Anchored complements." `vibe-recall`
fits that shape without requiring Cart to depend on it, install it, or know it exists
when it isn't there.

## The mechanism, unchanged

Cart's own guide already specifies the detection method (guide/SKILL.md line 217):
"check the agent's available skills/tools list for any of these known complements."
That is a runtime scan of what the current session actually has loaded — the same
check `vibe-prompt`'s `--auto-handoff-vibe-sec` flag uses today (`skills/remediate/
SKILL.md` §"Step 1 — Availability check (Skill tool)": "check whether the `vibe-sec:
audit` Skill is available via the Skill tool registry... Not installed → fall back...
gracefully"). This proposal reuses that exact check for `vibe-recall:sweep`. No new
detection code, no filesystem probing, no plugin-config reads — Cart's own privacy
rule (guide/SKILL.md line 255: "Never enumerate the user's filesystem or Claude
config to discover plugins") already forbids anything else.

**Absence is not a failure path.** If `vibe-recall:sweep` isn't in the available
skills/tools list, Cart's Layer 1 already only announces a complement "if present"
(line 217) — the silent-skip behavior this proposal asks for is the framework's
existing default, not a new branch to write.

## Proposed table row

Added to the Anchored complements table in `guide/SKILL.md`:

| Complement | When it's installed, defer at... | What to say at deferral |
|---|---|---|
| `vibe-recall:sweep` | `/spec`, after architecture is proposed section-by-section (spec/SKILL.md step 4, line ~111) and before `docs/spec.md` is generated (line ~137); `/checklist`, after items are drafted (checklist/SKILL.md step 4, line ~179) and before `docs/checklist.md` is generated (line ~205) | "You've got `vibe-recall` installed — want me to sweep your own repos for prior art on [capability] before we lock this in?" |

## What gets called, and by what

Cart does not shell out to `engine/cli.mjs` directly. `vibe-recall`'s own guide
(`skills/guide/SKILL.md` §"The five invariants") draws a hard line between the
deterministic engine and the judgment layer that sits on top of it, and phrase
extraction from a spec is explicitly judgment work — `vibe-recall`'s own
`skills/sweep/SKILL.md` step 1 already does this for a spec file handed to it
directly: "pull out capability-bearing phrases — feature names, third-party
services, domain terms — not section headers or boilerplate. Run one sweep per
distinct capability phrase." Cart invoking `vibe-recall:sweep` through the Skill
tool — the same way the vibe-launch handoff at `spec/SKILL.md` line 93 and the
`superpowers:*` rows in the existing table already work — gets this for free
instead of Cart re-implementing its own phrase extractor. Concretely:

- **At `/spec`:** the candidate phrases are the architectural component headings
  Cart is about to write into `docs/spec.md` (step 4 already requires "every
  architectural component must have its own heading" — these are exactly the
  addresses `/checklist` later references, and exactly the phrases worth sweeping).
- **At `/checklist`:** the candidate phrases are each drafted item's title and
  "what to build" line, before the five-field format is finalized and written.

One sweep per phrase, same as `vibe-recall`'s own guidance for a multi-capability
document — Cart should not mash the whole spec into one query for the same reason
`vibe-recall` itself doesn't.

## What Cart does with a hit

`vibe-recall`'s own invariant governs this completely: **the index can suggest,
only a live read can claim** (`skills/guide/SKILL.md` §"The five invariants").
`sweep`'s output is leads, not fact — repo name, card depth, and a `why` line, never
source. Cart:

- **Never quotes a card field into `docs/spec.md` or `docs/checklist.md` as if it
  were verified content.** That would violate both plugins' invariants at once —
  `vibe-recall`'s "no claim without a live read" and Cart's own "Document artifacts
  ... the final artifact format is the plugin's contract with downstream commands"
  (guide/SKILL.md line 261).
- **Surfaces a hit as a genuine question**, the same shape `/spec`'s own
  "Architecture self-review" deepening question already uses to surface findings
  (spec/SKILL.md line 130: "Surface 2-3 findings as genuine questions for the
  builder"). Example: *"vibe-recall found a shallow card in `Aurora` matching
  'stripe checkout' — code evidence, not just docs. Want to pull `/vibe-recall:brief
  Aurora` before we spec a checkout flow from scratch?"*
- **Zero hits gets no mention.** `vibe-recall`'s own posture — "zero hits is a real
  answer... a recall tool that always finds something is a recall tool that is
  lying" — means Cart should not narrate a clean sweep. Silence on no-hit is
  correct behavior inherited, not a gap.
- **A `foreign`-classified or `DIVERGED` hit is not surfaced as clean prior art.**
  `sweep` already excludes `foreign` cards by default and flags `diverged` pairs in
  its `why` output; Cart passes that signal through rather than re-deciding it.
- **If the builder wants the hit**, Cart's move is to *stop and hand off* —
  recommend `/vibe-recall:brief <repo>` (verified writeup) and, if they choose to
  reuse rather than rebuild, `/vibe-taker:capture` from that brief — the same
  handoff chain `vibe-recall`'s own `:sweep` skill already ends on. Cart does not
  read the source itself, does not write the spec/checklist item as "already built,"
  and does not skip the architecture conversation — a verified hit changes what gets
  built (adapt vs. build fresh), not whether the builder and Cart have that
  conversation.

## Composition rules this proposal honors

Everything already governed by `guide/SKILL.md` §"Composition rules" applies
unmodified:

- **Defer, don't absorb.** Cart hands the sweep to `vibe-recall:sweep` and resumes
  its own flow with the result; it does not reimplement ranking, provenance
  filtering, or secret-shape scanning.
- **Announce once, at command start** (or, for this seam specifically, once per
  command invocation of the sweep — not per phrase).
- **Builder can decline.** "Skip the sweep, I know what I want here" is always a
  valid answer, same as any other complement offer.
- **Log it.** `complements_invoked` already exists in both `/spec`'s and
  `/checklist`'s session-logger contract (spec/SKILL.md line 48, checklist/SKILL.md
  line 47) — add `"vibe-recall:sweep"` when invoked. No new field.
- **Friction trigger inherited for free.** Both commands already log
  `complement_rejected` when a Pattern #13 offer is declined (spec/SKILL.md line 54,
  checklist/SKILL.md line 56); a declined `vibe-recall` offer is just another row
  through that same trigger.
- **Don't break composition mid-command.** If `vibe-recall:sweep` throws or returns
  something malformed, Cart falls back to its own flow silently — same rule already
  written for every other row in the table.

## Non-goals

- **This does not make `vibe-recall` a dependency.** Cart ships and works identically
  with or without it, today and after this row is added.
- **This does not change `docs/spec.md` or `docs/checklist.md`'s schema.** Whether a
  confirmed reuse gets its own heading, a footnote, or nothing at all in those
  artifacts is Cart's call — an open question below, not something this proposal
  decides on Cart's behalf.
- **This does not run `:index`.** A stale or absent index is a real, honest answer
  (`vibe-recall`'s own zero-hit and staleness posture) — Cart never triggers a
  cross-estate reindex as a side effect of a builder's spec session; that cost is
  the user's call in every other `vibe-recall` surface and should stay that way here.
- **This does not touch `/build`, `/prd`, or `/scope`.** Prior-art recall is most
  useful once there is an architecture or a checklist item to sweep against; earlier
  phases don't yet have a capability phrase worth searching on.

## Open question for Cart's maintainers

Should a confirmed reuse (builder ran `:brief`, chose to adapt rather than rebuild)
leave a visible trace in `docs/spec.md` — e.g. an annotation next to the affected
heading noting the source repo — so that `/build` and `/reflect` know a component
was adapted rather than built fresh? `vibe-recall` has no opinion here; it ends its
own involvement at the `:brief` handoff and never writes into a target repo or
document. This is squarely Cart's artifact-format call to make.
