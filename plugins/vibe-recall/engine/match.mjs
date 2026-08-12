// code-derived fields lead; prose is for discovery, not proof
const WEIGHTS = { symbols: 10, entrypoints: 8, gotchas: 5, claims: 4, deps: 3 };
const CODE_FIELDS = new Set(['symbols', 'entrypoints']);
const DEPTH_BONUS = { deep: 5, shallow: 0, 'shallow-remote': -2 };

export function terms(query) {
  return String(query).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
}

// inverse document frequency across the card set: a term in every card
// carries no information, a term in two carries a lot.
//
// Counted the same way scoreCard matches -- substring containment, not
// corpus tokenization. A term like "auth" never tokenizes out of
// "authenticateUser"/"getAuthToken"/"oauthCallback"; a token-based df read
// 0 for it and scored it as maximally rare even though it substring-hits
// most of the corpus. Restricting df to the query's own terms (usually a
// handful of words, never every token in 86 repos) keeps this cheap too.
export function idf(cards, queryTerms = []) {
  const n = Math.max(1, cards.length);
  const df = new Map();
  for (const term of new Set(queryTerms)) {
    let count = 0;
    for (const card of cards) {
      const hay = [...Object.keys(WEIGHTS)]
        .flatMap(f => card[f] || []).join(' ').toLowerCase();
      if (hay.includes(term)) count++;
    }
    df.set(term, count);
  }
  return (term) => Math.log((n + 1) / ((df.get(term) || 0) + 1)) + 1;
}

export function scoreCard(card, ts, ctx = {}, weightOf = () => 1) {
  let score = 0;
  let codeHits = 0;
  let docHits = 0;
  const why = [];

  for (const [field, weight] of Object.entries(WEIGHTS)) {
    const hay = (card[field] || []).join(' ').toLowerCase();
    const hits = ts.filter(t => hay.includes(t));
    if (hits.length) {
      for (const t of hits) score += weight * weightOf(t);
      if (CODE_FIELDS.has(field)) codeHits += hits.length; else docHits += hits.length;
      why.push(`${field}: ${hits.join(', ')}`);
    }
  }

  if (score === 0) return { score: 0, why, codeHits, docHits };

  // somebody else's code is not your prior art
  if (card.provenance === 'foreign' && !ctx.includeForeign) {
    return { score: 0, why: ['excluded: foreign provenance'], codeHits, docHits };
  }
  if (ctx.selfRepo && card.repo === ctx.selfRepo && !ctx.includeSelf) {
    return { score: 0, why: ['excluded: current repo'], codeHits, docHits };
  }
  if (docHits > 0 && codeHits === 0) why.push('documentation only, no code evidence');

  score += DEPTH_BONUS[card.depth] ?? 0;
  if (card.depth === 'deep') why.push('deep card');

  const ctxDeps = new Set(ctx.deps || []);
  const shared = (card.deps || []).filter(d => ctxDeps.has(d));
  if (shared.length) { score += 4; why.push(`stack affinity: ${shared.slice(0, 3).join(', ')}`); }

  if (card.canonical === false) { score -= 6; why.push('non-canonical sibling'); }
  if (card.diverged) why.push('DIVERGED clone pair, verify which copy is home');

  const ageDays = card.lastCommit
    ? (Date.now() / 1000 - card.lastCommit) / 86400
    : 3650;
  score += Math.max(0, 3 - ageDays / 365);

  return { score, why, codeHits, docHits };
}

export function rank(cards, query, ctx = {}) {
  const ts = terms(query);
  const weightOf = idf(cards, ts);
  return cards
    .map(card => ({ card, ...scoreCard(card, ts, ctx, weightOf) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);
}
