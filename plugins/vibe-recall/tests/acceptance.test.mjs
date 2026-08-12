import { enumerateLocal, collapseDuplicates } from '../engine/corpus.mjs';
import { makeEstate, cleanEstate, RICH_SPEC } from './fixture-estate.mjs';
import { buildShallowCard } from '../engine/cards.mjs';
import { rank } from '../engine/match.mjs';

// RICH_SPEC is the Task 7 spec, exported from the helper so the acceptance
// test and the card tests describe the same estate instead of drifting apart.
let estateRoot;
beforeAll(() => { estateRoot = makeEstate(RICH_SPEC); });
afterAll(() => cleanEstate(estateRoot));

test('end to end on the fixture estate: index then recall finds the right repo', () => {
  const cfg = { estateRoot, walls: ['Acme'], exclude: [] };
  const cards = collapseDuplicates(enumerateLocal(cfg)).map(r => buildShallowCard(r));

  // Guard before every absence assertion below. An empty card set satisfies
  // "does not match Acme" trivially, which is how the committed-gitlink
  // fixtures made the wall test pass while exercising nothing.
  expect(cards.length).toBeGreaterThan(0);
  expect(cards.map(c => c.repo)).toContain('GoodApp');

  // Finding 3 (final whole-branch review) called this test out by name: it
  // is the one test whose job is to prove composition end to end, and it
  // called rank() with the same bare {} the real hook-path bug did -- so it
  // never actually exercised ctx wiring, only the ranking algorithm itself.
  // A non-empty ctx here, derived the same way cli.mjs's sweep() and
  // banner.mjs's cwd-matching do (deps off the card that matches, plus a
  // deliberate selfRepo probe below), closes that gap.
  const goodApp = cards.find(c => c.repo === 'GoodApp');
  const ctx = { deps: goodApp.deps };
  const hits = rank(cards, 'stripe checkout', ctx);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].card.repo).toBe('GoodApp');

  // Prove ctx.selfRepo genuinely does something in this same composition,
  // not merely get passed through and ignored: excluding GoodApp as "the
  // current repo" must remove it from its own hits. The non-empty hits
  // check above proves this isn't a vacuous absence assertion.
  const selfExcluded = rank(cards, 'stripe checkout', { ...ctx, selfRepo: 'GoodApp' });
  expect(selfExcluded.every(h => h.card.repo !== 'GoodApp')).toBe(true);

  const serialized = JSON.stringify(cards);
  expect(serialized).not.toMatch(/Acme/);
  expect(serialized).not.toMatch(new RegExp(['sk', 'live'].join('_')));
});
