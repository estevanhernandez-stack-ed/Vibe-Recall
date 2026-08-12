#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { enumerateLocal, collapseDuplicates, normalizeRemote } from './corpus.mjs';
import { remoteOnly } from './remote.mjs';
import { buildShallowCard } from './cards.mjs';
import { rank } from './match.mjs';
import { deepenQueue } from './queue.mjs';
import { saveCards, readCards, bumpHits } from './store.mjs';
// Aliased, not imported bare as `banner`: the commands object below has its
// own `banner()` method. Object-literal method shorthand doesn't self-bind
// its own name (unlike a named function expression), so `banner` unaliased
// would still have correctly resolved to this import inside that method
// body today -- but that only holds by the accident of which syntax form
// was used. A later refactor to a named function expression for that
// method would silently turn this into infinite self-recursion instead of
// a call into the engine, with no error until it stack-overflowed at
// runtime. Aliasing removes the trap rather than relying on remembering it.
import { banner as renderBanner } from './banner.mjs';

const [cmd, ...rest] = process.argv.slice(2);

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg) {
    console.error('vibe-recall: no config. Run /vibe-recall first-run setup.');
    process.exit(2);
  }
  return cfg;
}

// engine/hook.mjs is what hooks/hooks.json actually spawns now -- a thin
// entry point that imports nothing but banner.mjs, so the import-graph
// budget test walks the same graph the hook loads (see hook.mjs's own
// header comment for why that split exists). This file's `banner`
// subcommand and the stdin handling below still exist for manual testing
// (`node engine/cli.mjs banner "<text>"`), and duplicate hook.mjs's stdin
// logic rather than sharing it with hook.mjs, on purpose -- hook.mjs's
// entire reason for existing is a dependency graph provably limited to
// banner.mjs, and importing from this file (which pulls in config.mjs,
// corpus.mjs, remote.mjs, cards.mjs, queue.mjs) would defeat that.
//
// The UserPromptSubmit hook's exact prompt-delivery contract was resolved
// after this file's first pass guessed wrong (there is no $CLAUDE_USER_PROMPT
// environment variable -- confirmed absent from the reference). The real
// contract, corroborated from two independent sources rather than trusted on
// one: a Claude Code specialist agent reports the payload arrives as JSON on
// stdin shaped like
//   { session_id, prompt_id, transcript_path, cwd, permission_mode,
//     hook_event_name, user_input }
// with the prompt text on "user_input"; vibe-wrap (same plugin family) ships
// a working SessionEnd hook that reads hook_event_name/cwd/transcript_path
// off stdin JSON the same snake_case way, which is what makes "user_input"
// credible over a camelCase guess. Still not verified against a live
// session, so "user_input" leads the candidate list but the rest stay as
// fallback -- keeping them costs nothing and is exactly the insurance that
// would have covered this contract differing from what a doc pass concluded,
// which is the situation that produced this fix. An explicit argv prompt
// always wins (also what makes `vibe-recall banner "<text>"` usable by
// hand); with no argv, read stdin once, and if the payload isn't the JSON
// shape at all, fall back to treating the raw stdin text as the prompt
// itself. A TTY stdin (no pipe attached -- a human ran this directly) is
// never read, so this can't hang waiting for input that will never come.
function readPromptFromStdin() {
  if (process.stdin.isTTY) return '';
  let raw;
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
  if (!raw) return '';
  try {
    const payload = JSON.parse(raw);
    return payload.user_input ?? payload.prompt ?? payload.user_prompt ?? payload.userPrompt ?? '';
  } catch {
    return raw;
  }
}

// Final review, Finding B1: the bare `repo` field (a directory basename) is
// not a stable identity across a re-index -- collapseDuplicates only merges
// entries sharing a normalized remote, so two physically distinct repos with
// the same basename and different remotes (a shape a depth-bounded walk
// finds routinely: same-named projects nested under different parent
// directories), or one local repo plus an unrelated remote-only repo from
// remoteOnly(), both carry an identical `repo` value. Keying the
// carry-forward Map on that name alone made `new Map(...)`'s last-write-wins
// silently pick one of them to represent both, cross-contaminating
// recallHits/depth/features between unrelated repos on the very next index
// run. Prefer the normalized remote (stable across a repo being renamed or
// moved, and already the same identity collapseDuplicates itself groups by);
// fall back to the absolute local path when there is no remote (still
// unique per repo, since two directories cannot share one path); fall back
// to the bare name only when neither exists (a remote-only record with no
// URL should not occur in practice, but this keeps the function total rather
// than throwing on an unexpected shape).
function identityKey(record) {
  const remote = normalizeRemote(record.remote);
  if (remote) return `remote:${remote}`;
  if (record.path) return `path:${record.path}`;
  return `name:${record.repo}`;
}

// Final review, Finding B2: depth/features used to carry forward whenever
// `prior.depth === 'deep'`, with no check on *how* that repo went deep. A
// repo can be indexed under one origin on one run (local, deepened by
// reading real source at a real path) and a different origin on the next
// (its local clone disappears, but it is still enumerable through a
// configured GitHub account -- origin: 'remote', path: null, depth:
// 'shallow-remote', per buildShallowCard's remote-only branch). Re-stamping
// depth: 'deep' and re-attaching features onto that remote-only record is a
// lie: 'deep' means "read from real local source," and the attached
// features' file paths point at a local clone that no longer exists to
// verify against. recallHits is not origin-scoped the same way -- it is a
// record of demand (how often a sweep found this repo useful), which stays
// true regardless of which origin currently represents it -- so it always
// carries forward when the repo is still present at all.
//
// Exported (not just used inline in index() below) so this exact merge --
// not a reimplementation of it -- can be driven directly against hand-built
// fresh/prior pairs in tests, including the origin-change shape that would
// otherwise require a live `gh` subprocess and a real GitHub account to
// reproduce end to end.
export function applyCarryForward(fresh, prior) {
  if (!prior) return fresh;
  fresh.recallHits = prior.recallHits || 0;
  if (prior.depth === 'deep' && prior.origin === fresh.origin) {
    fresh.depth = 'deep';
    if ('features' in prior) fresh.features = prior.features;
  }
  return fresh;
}

const commands = {
  index() {
    const cfg = requireConfig();
    // enumerateLocal itself supplies head/lastCommit on every record (folded
    // into its existing per-repo git pass) so collapseDuplicates's
    // divergence check has real data to compare, not undefined on both
    // sides. That fix lives in corpus.mjs, not here -- this command is just
    // a caller of the library, and any other caller composing the same two
    // functions gets the same correct answer.
    const locals = collapseDuplicates(enumerateLocal(cfg));
    const remotes = remoteOnly(cfg, locals);
    // Read the outgoing index BEFORE it gets overwritten below. index()
    // used to rebuild every card from scratch through buildShallowCard
    // (which hardcodes recallHits: 0 and depth: 'shallow') and hand that
    // fresh array straight to saveCards -- a whole-file replace with no
    // memory of what was there before. That silently reverted every deep
    // card /vibe-recall:deepen had ever written (real source read,
    // features[] recorded) back to shallow on the very next index run --
    // which banner.mjs itself tells the user to do whenever the index looks
    // stale. Reproduced live: recallHits and features vanished too, since
    // neither survives a fresh buildShallowCard call either.
    const previousByIdentity = new Map(readCards().map(c => [identityKey(c), c]));
    // Both local and remote-only repos build through the same shallow-card
    // indexer. buildShallowCard already branches on repo.path === null and
    // emits the full schema-required shape (provenance, provenanceKnown,
    // dedupVerified, skippedByFilename/Content, scanTruncated, truncatedBy,
    // ...) for the remote-only case -- depth: 'shallow-remote', no local
    // walk. Hand-rolling a separate remote card literal here would drift
    // from card.schema.json every time the schema grows a field; reusing
    // the indexer keeps the two populations validating against one
    // definition instead of two.
    // A repo that has genuinely disappeared from the estate (renamed,
    // deleted, moved out from under estateRoot) has no `prior` entry and
    // correctly drops out -- carrying earned state forward across a rebuild
    // must never turn into "cards never die." recallHits always carries
    // forward for a repo still present: it is the deepen queue's whole
    // ranking signal (queue.mjs sorts by it), and a fresh shallow card would
    // otherwise reset it to 0 on every reindex regardless of depth.
    // depth/features only carry forward when the prior card had actually
    // earned 'deep' under the SAME origin the fresh record now has -- see
    // applyCarryForward above for why the origin check matters. A repo that
    // was merely 'shallow' or 'shallow-remote' before gets this run's
    // honest, freshly scanned read, not a stale prior state pinned forever.
    const cards = [...locals, ...remotes].map(r => {
      const fresh = buildShallowCard(r);
      const prior = previousByIdentity.get(identityKey(fresh));
      return applyCarryForward(fresh, prior);
    });
    const p = saveCards(cards);
    console.log(`indexed ${cards.length} repos -> ${p}`);
    const diverged = cards.filter(c => c.diverged);
    if (diverged.length) {
      console.log(`\nDIVERGED clone pairs, resolve before trusting these:`);
      for (const c of diverged) console.log(`  ${c.repo} vs ${c.siblings.join(', ')}`);
    }
  },

  sweep() {
    // match.mjs's rank() has supported ctx.selfRepo/ctx.deps/ctx.includeForeign
    // since the matcher was built, and each is unit-tested directly against
    // rank() -- but this command is the only real caller, and until now it
    // passed a bare {}. That is the same class of defect as three earlier
    // ones in this build (the tenant wall enforced nowhere, divergence keyed
    // on a field nobody populated, canonical-by-lastCommit with lastCommit
    // always undefined): a capability built and proven in isolation, dead in
    // composition, because the unit tests call the library directly and only
    // this one real caller ever skipped wiring it through.
    const includeSelf = rest.includes('--include-self');
    const includeForeign = rest.includes('--include-foreign');
    const query = rest.filter(a => a !== '--include-self' && a !== '--include-foreign').join(' ');

    const cards = readCards();
    const ctx = { includeSelf, includeForeign };

    // The current repo is whichever indexed card's path the cwd falls under
    // -- longest match wins, in the unlikely case more than one card's path
    // is a prefix of cwd. Derived from data enumerateLocal already put on
    // the card; no extra git call, no extra file read. A cwd outside every
    // indexed repo's path (estate root, a scratch dir, before the estate has
    // ever been indexed) is a legitimate case, not an error: selfCard stays
    // undefined, ctx.selfRepo is never set, and rank() applies no
    // self-exclusion at all -- the same as if --include-self had nothing to
    // do.
    const cwd = process.cwd().split(path.sep).join('/');
    const selfCard = cards
      .filter(c => c.path && (cwd === c.path || cwd.startsWith(`${c.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (selfCard) {
      ctx.selfRepo = selfCard.repo;
      ctx.deps = selfCard.deps || [];
    }

    const ranked = rank(cards, query, ctx);
    const hits = ranked.slice(0, 10);

    if (hits.length === 0) {
      console.log(`No prior art in your estate for "${query}". Build it fresh.`);
    } else {
      bumpHits(hits.map(h => h.card.repo));
      for (const h of hits) {
        console.log(`${h.card.repo.padEnd(24)} ${h.card.depth.padEnd(14)} ${h.why.join(' | ')}`);
      }
    }

    // Silent exclusion is exactly how the fork filter's known false positive
    // would go unnoticed -- vitals names foreign repos by name for the same
    // reason. Only report what this query actually matched and this run
    // actually dropped -- not a blanket "exclusion is on" notice -- so a
    // zero-hit run still says plainly when the only real match was excluded,
    // not just "no prior art."
    //
    // The rerun check below is sliced to the same top-10 cutoff `hits` above
    // uses, not the full ranked array. Reviewer-caught defect: comparing
    // against the unsliced list let this notice promise "rerun with
    // --include-self to see it" even when the excluded card matched but
    // ranked 11th or worse -- a rerun would still not show it, and the
    // promise would be false on any query with more than ten real matches.
    // The notice may only claim what a literal rerun would actually put in
    // front of the user.
    if (selfCard && !includeSelf) {
      const withSelf = rank(cards, query, { ...ctx, includeSelf: true }).slice(0, 10);
      if (withSelf.some(h => h.card.repo === selfCard.repo)) {
        console.log(`(excluded: ${selfCard.repo}, the repo you're in -- rerun with --include-self to see it)`);
      }
    }
    if (!includeForeign) {
      const withForeign = rank(cards, query, { ...ctx, includeForeign: true }).slice(0, 10);
      const droppedForeign = withForeign.filter(h => h.card.provenance === 'foreign');
      if (droppedForeign.length) {
        const plural = droppedForeign.length === 1 ? '' : 's';
        const pronoun = droppedForeign.length === 1 ? 'it' : 'them';
        console.log(`(excluded: ${droppedForeign.length} foreign repo${plural} -- rerun with --include-foreign to see ${pronoun})`);
      }
    }
  },

  queue() {
    for (const c of deepenQueue(readCards()).slice(0, 20)) {
      console.log(`${String(c.recallHits || 0).padStart(3)}  ${c.repo}`);
    }
  },

  vitals() {
    const cards = readCards();
    const deep = cards.filter(c => c.depth === 'deep').length;
    const skippedSecretFiles = cards.reduce((n, c) => n + (c.skippedSecretFiles || 0), 0);
    const foreign = cards.filter(c => c.provenance === 'foreign');
    const truncated = cards.filter(c => c.scanTruncated).length;
    console.log(`repos indexed      ${cards.length}`);
    console.log(`deep cards         ${deep}`);
    console.log(`queue depth        ${deepenQueue(cards).length}`);
    console.log(`diverged pairs     ${cards.filter(c => c.diverged).length}`);
    // Foreign-classified and scan-truncated counts exist for the same
    // reason: a user who can't see what the index excluded or cut short
    // can't correct it. The fork filter has one known false positive in
    // the real estate -- naming the repos, not just the count, is how a
    // user would actually find it.
    console.log(`foreign repos      ${foreign.length}`);
    if (foreign.length) {
      for (const c of foreign) console.log(`  ${c.repo}`);
    }
    console.log(`scan truncated     ${truncated}`);
    console.log(`secret-file skips  ${skippedSecretFiles}`);
  },

  banner() {
    // UserPromptSubmit hook semantics: exit 2 blocks the prompt AND erases
    // the user's typed text; any other nonzero exit is non-blocking but
    // still an error the user didn't ask for. A recall advisory has no
    // business doing either -- an unexpected failure here (malformed
    // stdin, a stdin read error, a card whose shape breaks match.mjs's
    // formatting, anything not already caught inside banner.mjs) must
    // degrade to silence and a clean exit, never propagate. This is a
    // second, outer safety net on top of banner.mjs's own internal
    // try/catch around readCards -- it exists so that "never crash the
    // hook" holds even against a failure mode nobody has thought of yet,
    // not just the ones already named inside the engine function.
    try {
      const prompt = rest.join(' ') || readPromptFromStdin();
      const out = renderBanner(prompt);
      if (out) console.log(out);
    } catch {
      // Swallow deliberately. Silence is always the safe fallback for a
      // hook; a stack trace on stderr is not worth risking exit 2.
    }
  }
};

// Guarded so this file can also be imported as a plain module (tests import
// `applyCarryForward` and `identityKey` directly, to exercise the exact
// merge logic against hand-built card pairs without spawning a real
// subprocess) without immediately dispatching a subcommand off whatever
// happens to be on the importing process's argv -- which, for a test
// runner, is never a vibe-recall subcommand and would otherwise call
// process.exit(1) and take the whole test run down with it. Direct
// invocation (`node engine/cli.mjs <cmd>`, including every existing
// subprocess-based test in tests/cli.test.mjs) is unaffected: argv[1] is
// this file's own path in that case, so the comparison still matches and
// dispatch still runs exactly as before.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = commands[cmd];
  if (!run) {
    console.error('usage: vibe-recall <index|sweep|queue|vitals|banner>');
    process.exit(1);
  }
  run();
}
