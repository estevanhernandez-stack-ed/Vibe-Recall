---
name: brief
description: This skill should be used when the user says "/vibe-recall:brief <repo>", "give me the brief on X", "show me what X has", or wants a verified writeup of one hit from a prior sweep. Re-reads the named repo live at its current HEAD -- never trusts a card's cached path -- and ends with the vibe-taker handoff. The only skill in the plugin allowed to author claims about source.
---

# vibe-recall brief

Load skills/guide/SKILL.md first.

**The index can suggest, only a live read can claim.** That sentence is the whole reason
this skill exists separately from `:sweep`. A card is built whenever `:index` last ran and
can be hours or weeks stale; every fact in a brief has to be true right now, at the repo's
current HEAD, not true when the card was written.

## 1. Take the repo name

The argument is a repo name from a prior `:sweep`. If `:brief` is invoked standalone, run a
one-off sweep first to locate the card. Read that card to get its recorded `path`, `depth`,
and `origin` -- but treat every field on it as a lead, not a fact, past this point.

## 2. A shallow-remote hit -- say so and stop short

If the card's `depth` is `shallow-remote` (origin `remote`, no local `path`): **the repo is
not on this machine.** Say that plainly, first. Limit every claim in the brief to what the
GitHub API actually returned when `:index` ran -- README content, language breakdown,
top-level tree -- nothing from inside a file `:index` never had a working copy to read.
Offer to clone the repo before going further, and stop there; there is no live HEAD to
re-verify against without a clone.

## 3. A local hit -- re-read live, at current HEAD

1. Run `git -C <card.path> rev-parse --short HEAD` yourself. That is the HEAD this brief
   cites, whether or not it matches the card's own `head` field. A card behind current HEAD
   is unremarkable -- the brief always cites current reality, never the card's snapshot.
2. Open every file the brief is about to cite with the Read tool, in this session, right
   now. **Never quote a path from the card without opening it.** A card's `symbols` and
   `entrypoints` are index-time leads for where to look, not verified content -- they can be
   wrong, renamed, or simply gone by the time anyone reads them again.
3. From what was actually read, work out: the real `file:line` range the relevant code
   lives at, the contract (what goes in, what comes out), a gotcha worth carrying over, and
   one thing worth redoing if this were built again today.

## 4. Emit the brief

```
PRIOR ART  <capability>
source     <repo> @ <live HEAD>  (<local|shallow-remote>, <shallow|deep> card, indexed <indexedAt>)

shape      <path>:<start>-<end>
           <path>:<start>-<end>
contract   <signature or one-line input/output>
gotcha     <the thing that will bite a naive copy>
redo       <what would change>

take it    cd to <repo>, then:
           /vibe-taker:capture <path>
```

Multiple `shape` lines when a feature spans files. Omit `gotcha`/`redo` only when a genuine
read turned up nothing to say there -- rare -- and say so rather than leaving the line
blank with no explanation.

## 5. The handoff -- invents nothing

End every local brief with the source repo path and the literal capture line, no flags:

```
/vibe-taker:capture <path>
```

`<path>` is a folder, file, or glob relative to the source repo -- `/vibe-taker:capture`
takes exactly that one positional argument and operates on the *current* repo, which is why
the brief also says explicitly to `cd` there first. Do not invent a flag for naming the
source repo or the feature on this command: it accepts none today, and adding one here
would hand the user a command that fails the moment they run it. vibe-recall's job ends at
the handoff -- it never runs capture itself and never writes into the target.

There is no `brief` engine subcommand. Everything above -- the live re-read, the shape
extraction, the contract, gotcha, and redo -- is this skill's own judgment, not a call into
`engine/cli.mjs`.
