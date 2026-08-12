import { rank, scoreCard, idf, terms } from '../engine/match.mjs';

const card = (over = {}) => ({
  repo: 'A', depth: 'shallow', canonical: true, lastCommit: 1000,
  provenance: 'own', claims: [], gotchas: [], symbols: [], deps: [],
  entrypoints: [], stack: { services: [] }, ...over
});

test('a claim hit outranks a dependency hit', () => {
  const claimy = card({ repo: 'Claimy', claims: ['stripe checkout flow'] });
  const deppy = card({ repo: 'Deppy', deps: ['stripe'] });
  const out = rank([deppy, claimy], 'stripe checkout', {});
  expect(out[0].card.repo).toBe('Claimy');
});

test('deep cards outrank shallow at equal term score', () => {
  const deep = card({ repo: 'Deep', depth: 'deep', claims: ['stripe'] });
  const shallow = card({ repo: 'Shallow', claims: ['stripe'] });
  expect(rank([shallow, deep], 'stripe', {})[0].card.repo).toBe('Deep');
});

test('stack affinity lifts a matching stack', () => {
  const same = card({ repo: 'Same', claims: ['auth'], deps: ['next'] });
  const other = card({ repo: 'Other', claims: ['auth'], deps: ['wpf'] });
  const out = rank([other, same], 'auth', { deps: ['next'] });
  expect(out[0].card.repo).toBe('Same');
});

test('a non-canonical sibling is penalised below its canonical twin', () => {
  const canon = card({ repo: 'Canon', claims: ['pdf'], canonical: true });
  const dupe = card({ repo: 'Dupe', claims: ['pdf'], canonical: false });
  expect(rank([dupe, canon], 'pdf', {})[0].card.repo).toBe('Canon');
});

test('no match returns an empty array, never a stretched hit', () => {
  expect(rank([card({ claims: ['weather'] })], 'quantum bicycle', {})).toEqual([]);
});

test('every returned hit explains itself', () => {
  const out = rank([card({ claims: ['stripe checkout'] })], 'stripe', {});
  expect(out[0].why.length).toBeGreaterThan(0);
});

// --- the four rules the cowpath run added ---

test('code evidence outranks prose evidence', () => {
  const inCode = card({ repo: 'Built', symbols: ['createCheckoutSession'] });
  const inProse = card({ repo: 'Planned', claims: ['createCheckoutSession someday'] });
  const out = rank([inProse, inCode], 'createCheckoutSession', {});
  expect(out[0].card.repo).toBe('Built');
  expect(out[0].codeHits).toBeGreaterThan(0);
  expect(out[0].docHits).toBe(0);
});

test('a documentation-only hit says so', () => {
  const out = rank([card({ claims: ['stripe checkout'] })], 'stripe', {});
  expect(out[0].why.join(' ')).toMatch(/documentation only/);
});

test('a rare term beats a term present in every card', () => {
  const cards = [
    card({ repo: 'Rare', symbols: ['themefeed', 'common'] }),
    ...Array.from({ length: 9 }, (_, i) => card({ repo: `C${i}`, symbols: ['common'] }))
  ];
  const rare = rank(cards, 'themefeed', {})[0];
  const commonTop = rank(cards, 'common', {})[0];
  expect(rare.card.repo).toBe('Rare');
  expect(rare.score).toBeGreaterThan(commonTop.score);
});

test('a foreign repo never ranks unless opted in', () => {
  const fork = card({ repo: 'UtilityFork', provenance: 'foreign', symbols: ['WinUI'] });
  expect(rank([fork], 'WinUI', {})).toEqual([]);
  expect(rank([fork], 'WinUI', { includeForeign: true })).toHaveLength(1);
});

test('the current repo is excluded from its own recall', () => {
  const self = card({ repo: 'ClipTool', symbols: ['ClipboardWriter'] });
  expect(rank([self], 'ClipboardWriter', { selfRepo: 'ClipTool' })).toEqual([]);
  expect(rank([self], 'ClipboardWriter',
    { selfRepo: 'ClipTool', includeSelf: true })).toHaveLength(1);
});

// --- fix round 1: idf's population must match scoreCard's population ---
//
// scoreCard matches by substring (hay.includes(t)) -- it does not care
// whether the term stood alone as its own token. idf must count document
// frequency the same way, or the two run over different populations and
// the rarity weight stops meaning what the design says it means.

test('a term that is only ever a substring of common identifiers gets a LOW rarity weight, not a maximal one', () => {
  // 10 cards, matching the shape of the real-estate hand-run: 6 of 10 carry
  // an identifier containing "auth" (authenticateUser / getAuthToken /
  // oauthCallback), but "auth" never appears as its own token in any of
  // them -- a token-based df would read 0 here and the term would score as
  // if it were nearly unique.
  const hidden = [
    card({ repo: 'H1', symbols: ['authenticateUser'] }),
    card({ repo: 'H2', symbols: ['getAuthToken'] }),
    card({ repo: 'H3', symbols: ['oauthCallback'] }),
    card({ repo: 'H4', symbols: ['authenticateUser'] }),
    card({ repo: 'H5', symbols: ['getAuthToken'] }),
    card({ repo: 'H6', symbols: ['oauthCallback'] })
  ];
  const clean = [
    card({ repo: 'C1', symbols: ['ephemeris'] }),
    card({ repo: 'C2', symbols: ['renderWidget'] }),
    card({ repo: 'C3', symbols: ['parseManifest'] }),
    card({ repo: 'C4', symbols: ['cacheLayer'] })
  ];
  const cards = [...hidden, ...clean];

  const authWeight = idf(cards, terms('auth'))('auth');
  const rareWeight = idf(cards, terms('ephemeris'))('ephemeris');

  // "auth" substring-hits 6 of 10 cards -- it must weigh far below a term
  // that hits only 1 of 10. Under the old token-only df this assertion
  // fails: df('auth') read 0 (no card's token set ever contains the bare
  // token "auth"), so the old weight landed at ~3.40 -- the same ballpark
  // as a genuinely unique term.
  expect(authWeight).toBeLessThan(2);
  expect(authWeight).toBeLessThan(rareWeight);
});

test('a genuinely rare term still receives a high weight -- the fix does not flatten everything', () => {
  const cards = [
    card({ repo: 'Rare', symbols: ['ephemeris'] }),
    ...Array.from({ length: 9 }, (_, i) => card({ repo: `Common${i}`, symbols: ['renderWidget'] }))
  ];
  const weight = idf(cards, terms('ephemeris'))('ephemeris');
  expect(weight).toBeGreaterThan(2.5);
});

test('idf boundary: empty corpus does not produce Infinity or NaN', () => {
  const weight = idf([], ['anything'])('anything');
  expect(Number.isFinite(weight)).toBe(true);
});

test('idf boundary: single-card corpus does not produce Infinity or NaN, present or absent', () => {
  const cards = [card({ claims: ['solo'] })];
  expect(Number.isFinite(idf(cards, ['solo'])('solo'))).toBe(true);
  expect(Number.isFinite(idf(cards, ['absent'])('absent'))).toBe(true);
});

test('idf boundary: a term present in every card still yields a positive weight, never zero', () => {
  const cards = Array.from({ length: 5 }, (_, i) => card({ repo: `U${i}`, claims: ['everywhere'] }));
  const weight = idf(cards, ['everywhere'])('everywhere');
  expect(weight).toBeGreaterThan(0);
});

// "Also do this" (final whole-branch review): every idf() call above passes
// a single query term, so the `for (const term of new Set(queryTerms))`
// loop has never run more than one iteration -- not the shape a real prompt
// takes. Two terms with genuinely different document frequencies in one
// idf() call, each checked independently, is the only way this actually
// exercises more than the loop's first pass.
test('idf computes an independent weight per term when the query has more than one term (the loop actually iterates)', () => {
  const cards = [
    card({ repo: 'Rare', symbols: ['ephemeris', 'renderWidget'] }),
    ...Array.from({ length: 9 }, (_, i) => card({ repo: `Common${i}`, symbols: ['renderWidget'] }))
  ];
  const weightOf = idf(cards, terms('ephemeris render'));
  const ephemerisWeight = weightOf('ephemeris');
  const renderWeight = weightOf('render');
  // Prove both terms genuinely have different document frequencies before
  // trusting the ordering assertion: 'ephemeris' hits 1/10 cards, 'render'
  // (a substring of every renderWidget) hits 10/10.
  expect(cards.filter(c => c.symbols.join(' ').includes('ephemeris')).length).toBe(1);
  expect(cards.filter(c => c.symbols.join(' ').includes('render')).length).toBe(10);
  expect(ephemerisWeight).toBeGreaterThan(renderWeight);
  expect(Number.isFinite(ephemerisWeight)).toBe(true);
  expect(Number.isFinite(renderWeight)).toBe(true);
});
