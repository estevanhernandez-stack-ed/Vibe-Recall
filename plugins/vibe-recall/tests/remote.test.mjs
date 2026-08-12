import path from 'node:path';
import { remoteOnly } from '../engine/remote.mjs';
import { assertNoWalled } from '../engine/corpus.mjs';

const fakeGh = () => JSON.stringify([
  { name: 'CloudOnly', url: 'https://github.com/e/CloudOnly' },
  { name: 'App', url: 'https://github.com/e/App' },
  { name: 'PublicRepo', url: 'https://github.com/e/PublicRepo' }
]);

test('returns only repos with no local clone', () => {
  const out = remoteOnly(
    { githubAccounts: ['e'] },
    [{ name: 'App', remote: 'git@github.com:e/App.git' }],
    fakeGh
  );
  // Prove non-emptiness: the fake gh result contains 3 repos, and we filtered to 2
  expect(fakeGh()).not.toBe('[]');
  expect(out.length).toBe(2);
  expect(out.map(r => r.name)).toEqual(['CloudOnly', 'PublicRepo']);
  expect(out[0].origin).toBe('remote');
  expect(out[0].provenance).toBe('own');
  expect(out[0].provenanceKnown).toBe(false);
});

test('walled repo names are filtered from remoteOnly output', () => {
  const out = remoteOnly(
    { githubAccounts: ['e'], walls: ['PublicRepo'] },
    [],
    fakeGh
  );
  // Prove non-emptiness: the fake gh result contains 3 repos
  const list = JSON.parse(fakeGh());
  expect(list.length).toBe(3);
  // After filtering by walls, PublicRepo should not appear
  expect(out.map(r => r.name)).toEqual(['CloudOnly', 'App']);
  expect(out.every(r => r.name !== 'PublicRepo')).toBe(true);
});

test('walled repo names are filtered case-insensitively', () => {
  const out = remoteOnly(
    { githubAccounts: ['e'], walls: ['publicrepo'] },
    [],
    fakeGh
  );
  // Case-insensitive match should catch 'PublicRepo' even with lowercase wall
  expect(out.map(r => r.name)).toEqual(['CloudOnly', 'App']);
  expect(out.every(r => r.name.toLowerCase() !== 'publicrepo')).toBe(true);
});

test('assertNoWalled throws if a walled name record escapes', () => {
  const walled = [{ name: 'PublicRepo', origin: 'remote', provenance: 'own' }];
  expect(() => assertNoWalled(walled, ['PublicRepo'])).toThrow(/walled repo "PublicRepo" escaped/);
});

test('assertNoWalled throws if a walled path record escapes', () => {
  const walled = [{ path: path.join('/home/user/PublicRepo/myrepo'), origin: 'local', provenance: 'own' }];
  expect(() => assertNoWalled(walled, ['PublicRepo'])).toThrow(/walled path.*escaped/);
});

test('assertNoWalled does not throw on path segments containing but not matching a wall', () => {
  // AcmeData is a single path segment that contains "Acme" as a substring
  // but is not equal to Acme as a segment, so should not throw
  const notWalled = [{ path: path.join('/home/user/AcmeData/myrepo'), origin: 'local', provenance: 'own' }];
  expect(() => assertNoWalled(notWalled, ['Acme'])).not.toThrow();
});

test('gh missing degrades to empty, never throws', () => {
  const boom = () => { throw new Error('gh: not found'); };
  expect(remoteOnly({ githubAccounts: ['e'] }, [], boom)).toEqual([]);
});

test('no configured accounts means no remote enumeration', () => {
  expect(remoteOnly({}, [], fakeGh)).toEqual([]);
});

test('remote repos include provenance and provenanceKnown fields', () => {
  const out = remoteOnly(
    { githubAccounts: ['e'] },
    [],
    fakeGh
  );
  expect(out.length).toBeGreaterThan(0);
  expect(out.every(r => r.provenance === 'own')).toBe(true);
  expect(out.every(r => r.provenanceKnown === false)).toBe(true);
});

// --- Finding 2 (final whole-branch review): the wall was only ever checked
// against r.name -- the enumerated ACCOUNT itself was never compared to the
// walls, and neither was the owner segment of r.url. assertNoWalled can't
// save it: remote records carry path: null, so only its name branch ever
// runs. A whole walled org (e.g. a configured Acme GitHub account) was
// fully indexed, and so was any innocently-named repo living under a
// walled owner. This is the tenant-wall invariant a producer violated --
// the single most important guarantee this plugin makes.

const walledOrgGh = () => JSON.stringify([
  { name: 'billing-portal', url: 'https://github.com/Acme/billing-portal' },
  { name: 'inventory-sync', url: 'https://github.com/Acme/inventory-sync' }
]);

test('a configured GitHub account matching a wall enumerates nothing at all -- reproduces the live incident verbatim', () => {
  // Prove the fake gh output genuinely contains repos before trusting the
  // empty-output assertion below.
  expect(JSON.parse(walledOrgGh()).length).toBe(2);
  const out = remoteOnly({ githubAccounts: ['Acme'], walls: ['Acme'] }, [], walledOrgGh);
  expect(out).toEqual([]);
});

test('a walled owner segment on an otherwise-innocent repo name is dropped, even when the configured account is not itself walled', () => {
  const mixedOwnerGh = () => JSON.stringify([
    { name: 'InnocentName', url: 'https://github.com/Acme/InnocentName' },
    { name: 'RealRepo', url: 'https://github.com/e/RealRepo' }
  ]);
  // Prove the fake gh output genuinely mixes a walled-owner repo with a
  // clean one before trusting the filtered result below -- the walled repo
  // here would previously pass because assertNoWalled only ever checked
  // r.name ('InnocentName'), never the owner segment of r.url.
  const list = JSON.parse(mixedOwnerGh());
  expect(list.some(r => r.url.includes('/Acme/'))).toBe(true);
  const out = remoteOnly({ githubAccounts: ['e'], walls: ['Acme'] }, [], mixedOwnerGh);
  expect(out.map(r => r.name)).toEqual(['RealRepo']);
});
