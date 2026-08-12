import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  classifyProvenance, repoStats, enumerateLocal, DEFAULT_PROVENANCE,
  discoverAuthors, minEstateRepos
} from '../engine/corpus.mjs';
import { makeEstate, cleanEstate } from './fixture-estate.mjs';

// Originally { minAuthorshipRatio: 0.5, minCommitsPerFile: 0.01 } per the
// Task 5b brief. Round 1's real-estate gate proved 0.5 insufficient (it
// sits exactly on the fork's ratio and the strict "<" comparison lets it
// through) and raised the shipped default to 0.75; round 3 removed
// minCommitsPerFile/density entirely after a full-estate sweep found it
// produced 13 false positives and zero unique true positives. T is kept in
// sync with DEFAULT_PROVENANCE so these tests exercise the real, currently
// shipped behavior rather than a threshold already proven wrong.
const T = { minAuthorshipRatio: 0.75 };

// Builds a small estate of real git repos with explicit per-commit identities,
// so identity-discovery tests can control exactly which authors repeat across
// how many repos -- something the shared fixture-estate.mjs (fixed at two
// repos, one identity) can't isolate on its own.
function makeCustomEstate(repoSpecs) {
  const estateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-custom-estate-'));
  for (const [name, commits] of Object.entries(repoSpecs)) {
    const dir = path.join(estateRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    execSync('git init -q', { cwd: dir });
    for (const { author, email, message } of commits) {
      execSync(`git config user.name "${author}"`, { cwd: dir });
      execSync(`git config user.email "${email}"`, { cwd: dir });
      execSync(`git commit -q --allow-empty -m "${message}"`, { cwd: dir });
    }
  }
  return estateRoot;
}

test('a real repo the user wrote is their own', () => {
  // ClipCatcher: 57 commits, all the user's
  expect(classifyProvenance(
    { totalCommits: 57, ownCommits: 57 }, T)).toBe('own');
});

test('a fork with thousands of files and two commits is foreign', () => {
  // UtilityFork: 2 commits, 1 the user's. (Its ~8000 files were
  // only ever relevant to the now-removed density rule; authorship alone
  // catches this one -- see the dedicated describe block below.)
  expect(classifyProvenance(
    { totalCommits: 2, ownCommits: 1 }, T)).toBe('foreign');
});

test('low authorship alone is enough to mark foreign', () => {
  expect(classifyProvenance(
    { totalCommits: 900, ownCommits: 40 }, T)).toBe('foreign');
});

test('a large repo the user genuinely wrote stays their own', () => {
  // mod-launcher: 1052 commits, all under the user's two identities
  expect(classifyProvenance(
    { totalCommits: 1052, ownCommits: 1052 }, T)).toBe('own');
});

test('an empty repo does not divide by zero', () => {
  expect(classifyProvenance(
    { totalCommits: 0, ownCommits: 0 }, T)).toBe('own');
});

// Fail open. An unconfigured author list must never silently hide the estate:
// with no identities to match, ownCommits is 0 for EVERY repo, and a naive
// ratio test would classify all 86 as foreign and return nothing, forever,
// with no error. Not classifiable is not the same as foreign.
test('no configured authors means classification is skipped, not failed', () => {
  expect(classifyProvenance(
    { totalCommits: 57, ownCommits: 0, authorsConfigured: false }, T))
    .toBe('own');
});

test('configured authors with zero matches is still foreign', () => {
  expect(classifyProvenance(
    { totalCommits: 57, ownCommits: 0, authorsConfigured: true }, T))
    .toBe('foreign');
});

describe('repoStats against a real fixture repo (fixtures commit as "Fixture Test")', () => {
  let estateRoot;

  beforeAll(() => { estateRoot = makeEstate(); });
  afterAll(() => { cleanEstate(estateRoot); });

  test('a matching author is credited with the repo\'s commit(s)', () => {
    const dir = path.join(estateRoot, 'GoodApp');
    const stats = repoStats(dir, ['Fixture Test']);
    expect(stats.totalCommits).toBeGreaterThan(0);
    expect(stats.ownCommits).toBe(stats.totalCommits);
    expect(stats.authorsConfigured).toBe(true);
  });

  test('no authors configured reports authorsConfigured: false, ownCommits stays 0', () => {
    const dir = path.join(estateRoot, 'GoodApp');
    const stats = repoStats(dir, []);
    expect(stats.totalCommits).toBeGreaterThan(0);
    expect(stats.ownCommits).toBe(0);
    expect(stats.authorsConfigured).toBe(false);
  });

  test('a configured author who never committed here is still "configured", just at 0', () => {
    const dir = path.join(estateRoot, 'GoodApp');
    const stats = repoStats(dir, ['Someone Else Entirely']);
    expect(stats.totalCommits).toBeGreaterThan(0);
    expect(stats.ownCommits).toBe(0);
    expect(stats.authorsConfigured).toBe(true);
  });
});

describe('enumerateLocal wires provenance onto every record it returns', () => {
  let estateRoot;

  beforeAll(() => { estateRoot = makeEstate(); });
  afterAll(() => { cleanEstate(estateRoot); });

  test('a matching configured author classifies every fixture repo as own', () => {
    const config = { estateRoot, walls: ['Acme'], exclude: [], authors: ['Fixture Test'] };
    const results = enumerateLocal(config);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.provenance === 'own')).toBe(true);
  });

  // NOTE: this can no longer use the shared 2-repo fixture estate. Both
  // GoodApp and OtherApp are authored by "Fixture Test", which now gets
  // auto-discovered (2/2 repos clears minEstateRepos(2) = 2) regardless of
  // what's configured -- so a wrong configured author no longer starves the
  // classifier of a real identity the way it did before discovery existed.
  // A wrong config only proves 'foreign' when discovery *also* has nothing
  // to offer, which requires an estate where no identity repeats.
  test('a configured author that never committed classifies foreign when discovery also finds nothing', () => {
    const estateRoot = makeCustomEstate({
      RepoA: [{ author: 'Author One', email: 'one@example.invalid', message: 'a1' }],
      RepoB: [{ author: 'Author Two', email: 'two@example.invalid', message: 'b1' }],
      RepoC: [{ author: 'Author Three', email: 'three@example.invalid', message: 'c1' }]
    });
    try {
      const config = {
        estateRoot, walls: ['Acme'], exclude: [], authors: ['Someone Else Entirely']
      };
      const results = enumerateLocal(config);
      expect(results.length).toBe(3);
      expect(results.every(r => r.provenance === 'foreign')).toBe(true);
    } finally {
      cleanEstate(estateRoot);
    }
  });

  test('discovery alone (no explicit config) still classifies every fixture repo as own', () => {
    const config = { estateRoot, walls: ['Acme'], exclude: [] };
    const results = enumerateLocal(config);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.provenance === 'own')).toBe(true);
  });
});

describe('identity discovery: found in many repos vs. found in one', () => {
  test('an identity in 1 repo out of 20 is not an owner identity; one in 12 of 20 is', () => {
    const shortlogsByRepo = [];
    for (let i = 0; i < 20; i++) {
      const shortlog = [];
      if (i < 12) shortlog.push({ name: 'Frequent Author', count: 5 });
      if (i === 0) shortlog.push({ name: 'Rare Author', count: 1 });
      shortlogsByRepo.push(shortlog);
    }
    const discovered = discoverAuthors(shortlogsByRepo);
    // discoverAuthors keys (and returns) identities lowercased -- see the
    // Finding 5 case-insensitive-keying fix and its dedicated coverage
    // below -- so the match here is case-insensitive by design, not a
    // literal string.
    expect(discovered.map(d => d.toLowerCase())).toContain('frequent author');
    expect(discovered.map(d => d.toLowerCase())).not.toContain('rare author');
  });

  // Round 2 shipped a scaling formula (max(2, ceil(repoCount * 0.05))).
  // Round 3's full-estate sweep proved it wrong: at its 5-repo threshold for
  // this ~86-repo estate, a legitimate rare alt identity (4 repos) stayed
  // undiscovered while both real foreign/outsider authors found in the
  // sweep sat at exactly 1 repo. minEstateRepos is now a flat 2, independent
  // of estate size -- kept as a function so a future estate could
  // recalibrate it, but the calibrated answer today doesn't scale.
  test('minEstateRepos is a flat floor of 2, independent of estate size', () => {
    expect(minEstateRepos(2)).toBe(2);
    expect(minEstateRepos(3)).toBe(2);
    expect(minEstateRepos(86)).toBe(2);
    expect(minEstateRepos(1000)).toBe(2);
  });

  test('explicitly configured authors are unioned with discovered ones, never replaced', () => {
    const estateRoot = makeCustomEstate({
      RepoA: [{ author: 'Frequent Person', email: 'fp@example.invalid', message: 'a1' }],
      RepoB: [{ author: 'Frequent Person', email: 'fp@example.invalid', message: 'b1' }],
      RepoC: [{ author: 'Frequent Person', email: 'fp@example.invalid', message: 'c1' }],
      RepoD: [{ author: 'Solo Vendor', email: 'sv@example.invalid', message: 'd1' }]
    });
    try {
      // 4 repos -> minEstateRepos(4) = 2. 'Frequent Person' appears in 3/4
      // repos -> discovered on its own. 'Solo Vendor' appears in only 1/4
      // -> would NOT be discovered; it is 'own' only because it's unioned
      // in from explicit config, proving config adds without replacing.
      const config = { estateRoot, walls: ['Acme'], exclude: [], authors: ['Solo Vendor'] };
      const results = enumerateLocal(config);
      expect(results.length).toBe(4);
      const byName = Object.fromEntries(results.map(r => [r.name, r.provenance]));
      expect(byName.RepoA).toBe('own');
      expect(byName.RepoB).toBe('own');
      expect(byName.RepoC).toBe('own');
      expect(byName.RepoD).toBe('own');
    } finally {
      cleanEstate(estateRoot);
    }
  });

  test('empty discovery plus empty config still fails open to own', () => {
    const estateRoot = makeCustomEstate({
      RepoA: [{ author: 'Author One', email: 'one@example.invalid', message: 'a1' }],
      RepoB: [{ author: 'Author Two', email: 'two@example.invalid', message: 'b1' }],
      RepoC: [{ author: 'Author Three', email: 'three@example.invalid', message: 'c1' }]
    });
    try {
      // Every author appears in exactly 1 of 3 repos; minEstateRepos(3) = 2,
      // so nothing clears the floor. No config supplied either.
      const config = { estateRoot, walls: ['Acme'], exclude: [] };
      const results = enumerateLocal(config);
      expect(results.length).toBe(3);
      expect(results.every(r => r.provenance === 'own')).toBe(true);
    } finally {
      cleanEstate(estateRoot);
    }
  });

  // Finding 5 (final whole-branch review): discoverAuthors keyed identities
  // by exact string (`new Set(shortlog.map(s => s.name))`) while
  // statsFromRaw matches case-insensitively. A developer committing as
  // "Taylor Morgan" on one machine and "taylor morgan" on another
  // never accumulates to minEstateRepos (2) under either spelling alone --
  // this estate's owner commits under five identities, so this is a live
  // scenario, not a hypothetical.
  test('discoverAuthors keys identities case-insensitively -- two case-variant spellings of one person are counted as the same identity', () => {
    const discovered = discoverAuthors([
      [{ name: 'Taylor Morgan', count: 3 }],
      [{ name: 'taylor morgan', count: 2 }]
    ]);
    // Prove the fix actually merged the two spellings into one identity
    // that clears the threshold, not just that the array contains
    // something.
    expect(discovered).toHaveLength(1);
    expect(discovered[0].toLowerCase()).toBe('taylor morgan');
  });

  test('case-variant spellings of one identity classify both repos own end to end, not foreign', () => {
    const estateRoot = makeCustomEstate({
      RepoA: [{ author: 'Taylor Morgan', email: 'e1@example.invalid', message: 'a1' }],
      RepoB: [{ author: 'taylor morgan', email: 'e2@example.invalid', message: 'b1' }],
      // A third identity repeating across two OTHER repos, purely so the
      // estate has a discovered identity at all -- otherwise
      // authorsConfigured stays false everywhere and classifyProvenance's
      // fail-open path would mask the bug regardless of what
      // discoverAuthors returns, proving nothing.
      RepoC: [{ author: 'Third Party', email: 'tp1@example.invalid', message: 'c1' }],
      RepoD: [{ author: 'Third Party', email: 'tp2@example.invalid', message: 'd1' }]
    });
    try {
      const config = { estateRoot, walls: ['Acme'], exclude: [] };
      const results = enumerateLocal(config);
      expect(results.length).toBe(4);
      const byName = Object.fromEntries(results.map(r => [r.name, r.provenance]));
      // Prove the estate genuinely has a discovered identity (authorsConfigured
      // really is true, not failing open) before trusting the RepoA/RepoB
      // verdicts below -- a fail-open pass would look identical to a real fix.
      expect(byName.RepoC).toBe('own');
      expect(byName.RepoD).toBe('own');
      expect(byName.RepoA).toBe('own');
      expect(byName.RepoB).toBe('own');
    } finally {
      cleanEstate(estateRoot);
    }
  });

  test('a fixture fork whose sole author appears only in that repo still classifies foreign', () => {
    const estateRoot = makeCustomEstate({
      RealRepoA: [
        { author: 'Real Owner', email: 'ro@example.invalid', message: 'a1' },
        { author: 'Real Owner', email: 'ro@example.invalid', message: 'a2' }
      ],
      RealRepoB: [
        { author: 'Real Owner', email: 'ro@example.invalid', message: 'b1' }
      ],
      FixtureFork: [
        { author: 'Real Owner', email: 'ro@example.invalid', message: 'fork-tweak' },
        { author: 'Upstream Vendor', email: 'uv@example.invalid', message: 'upstream-base' }
      ]
    });
    try {
      // 3 repos -> minEstateRepos(3) = 2. 'Real Owner' appears in all 3 ->
      // discovered. 'Upstream Vendor' appears only in FixtureFork's own
      // shortlog (1/3) -> never discovered, never configured. FixtureFork's
      // ratio is 1 own / 2 total = 0.5, below the 0.75 threshold.
      const config = { estateRoot, walls: ['Acme'], exclude: [] };
      const results = enumerateLocal(config);
      const byName = Object.fromEntries(results.map(r => [r.name, r.provenance]));
      expect(byName.RealRepoA).toBe('own');
      expect(byName.RealRepoB).toBe('own');
      expect(byName.FixtureFork).toBe('foreign');
    } finally {
      cleanEstate(estateRoot);
    }
  });
});

// Regression coverage for the real-estate finding: repoStats originally took
// totalCommits from `rev-list --count HEAD` (HEAD only) but ownCommits from
// `shortlog -sn --all` (every ref). ClipCatcher has a feature branch with a
// commit not reachable from HEAD, so the two numbers described different
// populations and the ratio came out to 58/57 = 1.02 -- proof the counts
// didn't agree. Both sides must now use --all.
describe('totalCommits and ownCommits are counted over the same ref scope', () => {
  test('a commit that only exists on an unmerged branch still counts toward both total and own', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-refscope-'));
    try {
      execSync('git init -q', { cwd: dir });
      execSync('git config user.email "scope@vibe-recall.local"', { cwd: dir });
      execSync('git config user.name "Scope Author"', { cwd: dir });
      execSync('git commit -q --allow-empty -m init', { cwd: dir });
      execSync('git checkout -q -b feature', { cwd: dir });
      execSync('git commit -q --allow-empty -m feature-work', { cwd: dir });
      execSync('git checkout -q -', { cwd: dir }); // back to the branch HEAD started on

      const stats = repoStats(dir, ['Scope Author']);
      expect(stats.totalCommits).toBe(2);
      expect(stats.ownCommits).toBe(2);
      expect(stats.ownCommits).toBeLessThanOrEqual(stats.totalCommits);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ownCommits never exceeds totalCommits across the fixture estate', () => {
    const estateRoot = makeEstate();
    try {
      for (const name of ['GoodApp', 'OtherApp']) {
        const stats = repoStats(path.join(estateRoot, name), ['Fixture Test']);
        expect(stats.totalCommits).toBeGreaterThan(0);
        expect(stats.ownCommits).toBeLessThanOrEqual(stats.totalCommits);
      }
    } finally {
      cleanEstate(estateRoot);
    }
  });
});

// History: with the old 0.5 ratio threshold, UtilityFork's authorship
// ratio landed exactly on the boundary (1/2 = 0.5, strict "<" comparison
// doesn't fire), so authorship never caught it and round 1 relied on a
// density/file-count rule (minCommitsPerFile: "foreign if few commits cover
// many files") as the actual excluder. Round 3's full-estate sweep proved
// that rule wrong: it fired on 13 of 86 real repos, every one a legitimate
// young repo with a large single-commit initial import, and zero unique true
// positives -- every real fork it caught, authorship (once raised to 0.75)
// already caught on its own. Density is now gone entirely; classifyProvenance
// is authorship-only. The old "density alone catches X" test asserted a rule
// that no longer exists (a test for a rule that no longer exists is dead
// weight, not coverage) and is replaced below with its logical opposite: the
// same shape now correctly stays 'own'.
describe('authorship alone determines provenance (density removed in round 3)', () => {
  test('the canonical fork is caught by authorship at the current 0.75 threshold', () => {
    // Real UtilityFork numbers (total=2, own=1). No density check
    // exists anymore to assist or interfere -- this is the whole rule.
    expect(classifyProvenance(
      { totalCommits: 2, ownCommits: 1 }, DEFAULT_PROVENANCE))
      .toBe('foreign');
  });

  test('at the old 0.5 threshold the same fork numbers pass as own (the round-1 bug, still pinned)', () => {
    // Documents why 0.5 was replaced: the fork's exact 0.5 ratio does not
    // trip the strict "<" comparison. Round 1 relied on density to catch
    // this at the old threshold; density is gone now, so at 0.5 nothing
    // catches it at all. Pinning this proves 0.75 is load-bearing, not
    // cosmetic.
    expect(classifyProvenance(
      { totalCommits: 2, ownCommits: 1 }, { minAuthorshipRatio: 0.5 }))
      .toBe('own');
  });

  test('a huge, file-heavy repo with clean authorship classifies own now that density has been removed', () => {
    // Same shape (ratio 1.0, thousands of files relative to few commits)
    // that the deleted density rule used to classify 'foreign' on its own.
    // Real-estate evidence (round 3) showed this shape describes legitimate
    // scaffolded/imported repos, not forks -- TriviaNight (1 commit, 396
    // files) was the real repo that surfaced this. It must be 'own' now.
    expect(classifyProvenance(
      { totalCommits: 5, ownCommits: 5 }, DEFAULT_PROVENANCE))
      .toBe('own');
  });
});

// Round 4, finding 2: gitRaw's two git calls (rev-list, shortlog) fail
// independently. Before this fix, a shortlog throw (corrupt refs, a
// mailmap parse error, odd encoding) while rev-list succeeded produced
// totalCommits > 0 with an empty shortlog, therefore ownCommits: 0,
// therefore ratio 0, therefore 'foreign' -- a real repo silently hidden
// because of a git read failure, not because of its actual authorship.
// "Not classifiable is not foreign" is the plugin's stated principle;
// this closes the one path where it didn't hold. Uses repoStats' injected
// `run` parameter to force the exact partial-failure shape a real git
// error would produce, since it isn't practical to corrupt a real repo's
// refs on demand.
describe('a shortlog read failure fails open (round 4)', () => {
  test('shortlog throwing while rev-list succeeds fails open to own, not foreign', () => {
    const mockRun = (args) => {
      if (args[0] === 'rev-list') return '42\n';
      if (args[0] === 'shortlog') throw new Error('simulated corrupt refs / mailmap failure');
      throw new Error(`unexpected git call in mock: ${args.join(' ')}`);
    };
    const stats = repoStats('/fake/dir', ['Configured Owner'], mockRun);
    expect(stats.totalCommits).toBe(42);
    expect(stats.ownCommits).toBe(0);
    expect(stats.shortlogFailed).toBe(true);
    expect(classifyProvenance(stats)).toBe('own');
  });

  test('shortlog succeeding but genuinely empty is not the same as failing -- still classifies foreign when configured', () => {
    // Contrast case, so the test above can't pass for the wrong reason
    // (e.g. any zero-ownCommits repo failing open regardless of cause).
    // A successful call that legitimately returns nothing must still be
    // scored normally, not treated as missing data.
    const mockRun = (args) => {
      if (args[0] === 'rev-list') return '42\n';
      if (args[0] === 'shortlog') return '';
      throw new Error(`unexpected git call in mock: ${args.join(' ')}`);
    };
    const stats = repoStats('/fake/dir', ['Configured Owner'], mockRun);
    expect(stats.totalCommits).toBe(42);
    expect(stats.ownCommits).toBe(0);
    expect(stats.shortlogFailed).toBe(false);
    expect(classifyProvenance(stats)).toBe('foreign');
  });
});
