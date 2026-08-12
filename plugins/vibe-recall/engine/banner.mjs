import { readCards } from './store.mjs';
import { rank } from './match.mjs';

// The trigger-word-plus-optional-article-plus-any-word shape this pattern
// used to have (`\s+(a|an|the|some)?\s*\w`) collapsed to "trigger word,
// whitespace, any word at all" whenever the article was absent -- which is
// most ordinary conversation. "what did you add to the config" and "I need
// to understand this build failure" both fired: "add" followed by the
// preposition "to", and "build" followed by the diagnostic noun "failure",
// each satisfied the bare \w with nothing else required. Demonstrated live
// and confirmed as a real defect, not a deliberate tradeoff of the original
// heuristic -- fixed here rather than shipped, since finding a latent bug
// while implementing a spec is not the same as the spec's own content, and
// the "use the brief's code verbatim" instruction was never meant to cover
// a bug the brief's code happened to contain.
//
// Now requires either an article ("build a dashboard", "add the login
// flow") -- which also incidentally fixes "the build failed", the same
// class of false positive -- or, with no article, an object that isn't in
// NOT_OBJECT: prepositions/pronouns a trigger word is never really "about"
// (to, it, on, in, at, that, this, you, me, us, them) and diagnostic nouns
// that mean "something built is broken", not "build this" (failure,
// failed, error(s), issue(s), problem(s), broke, broken). This still lets
// "let's add stripe checkout to Reel-Battles" fire -- "add stripe" has no
// article and "stripe" is not in either exclusion class, exactly the shape
// legitimate build-intent prose takes when it names the thing directly.
const NOT_OBJECT = [
  'to', 'it', 'on', 'in', 'at', 'that', 'this', 'you', 'me', 'us', 'them',
  'failure', 'failed', 'error', 'errors', 'issue', 'issues',
  'problem', 'problems', 'broke', 'broken'
];

const INTENT = [
  new RegExp(
    `\\b(build|create|add|implement|scaffold|wire up|set up)\\s+` +
    `(?:(?:a|an|the|some)\\s+\\w|(?!(?:${NOT_OBJECT.join('|')})\\b)\\w)`,
    'i'
  ),
  /\bwe need\b/i,
  /\bstart(ing)? a new\b/i,
  /\bnext feature\b/i
];

export function hasBuildIntent(prompt) {
  const p = String(prompt || '');
  if (p.length < 8) return false;
  return INTENT.some(re => re.test(p));
}

export function isStale(card, staleAfterDays = 14, now = new Date()) {
  if (!card.indexedAt) return true;
  const ageDays = (now.getTime() - Date.parse(card.indexedAt)) / 86400000;
  return ageDays > staleAfterDays;
}

// cwd, when supplied, is matched against every card's path exactly the way
// cli.mjs's sweep() matches process.cwd() -- longest-path-prefix wins, cwd
// outside every indexed repo's path is a legitimate no-op, not an error.
// This is pure string computation, deliberately not `node:path`: hook.mjs's
// entire reason for existing is an import graph provably limited to this
// file, and tests/banner-budget.test.mjs's import-graph walk enforces that.
// Card paths are already normalized to forward slashes by cards.mjs, so a
// literal backslash-to-forward-slash replace on cwd is enough to compare
// them -- no path-module semantics (drive letters, `..`, UNC) are needed
// here, only string equality/prefix.
function selfCtxFromCwd(cards, cwd) {
  if (!cwd) return {};
  const normalizedCwd = String(cwd).split('\\').join('/');
  const selfCard = cards
    .filter(c => c.path && (normalizedCwd === c.path || normalizedCwd.startsWith(`${c.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!selfCard) return {};
  return { selfRepo: selfCard.repo, deps: selfCard.deps || [] };
}

export function banner(prompt, env = process.env, cwd = null) {
  if (!hasBuildIntent(prompt)) return null;

  let cards;
  try { cards = readCards(env); } catch { return null; }
  if (cards.length === 0) {
    return 'BT4  no index yet. Run /vibe-recall:index to make your own work searchable.';
  }

  // cli.mjs's sweep() has derived ctx.selfRepo/ctx.deps from cwd since the
  // matcher was built -- this hook path (the highest-traffic surface in the
  // plugin, called on every UserPromptSubmit) called rank(cards, prompt, {})
  // instead, an always-empty context. Self-exclusion and stack affinity
  // were both dead here: reproduced live, a banner headed "you have built
  // this before" named the repo the user was standing in.
  const ctx = selfCtxFromCwd(cards, cwd);
  const hits = rank(cards, prompt, ctx).slice(0, 3);
  if (hits.length === 0) return null;

  if (hits.every(h => isStale(h.card, Number(env.VIBE_RECALL_STALE_DAYS) || 14))) {
    return 'BT4  index is stale. Run /vibe-recall:index to refresh before trusting a hit.';
  }

  const lines = hits.map(h => {
    const flag = h.card.diverged ? '  DIVERGED' : '';
    return `  ${h.card.repo.padEnd(22)} ${h.card.depth.padEnd(14)}${flag}`;
  });

  return [
    'BT4  you have built this before',
    ...lines,
    '  /vibe-recall:sweep <phrase>   for the evidence'
  ].join('\n');
}
