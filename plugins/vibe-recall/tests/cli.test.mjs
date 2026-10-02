import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import Ajv from 'ajv';
import { saveCards, readCards, bumpHits } from '../engine/store.mjs';
import { applyCarryForward } from '../engine/cli.mjs';
import { rank } from '../engine/match.mjs';
import { makeEstate, cleanEstate, RICH_SPEC } from './fixture-estate.mjs';

const cardSchema = JSON.parse(
  fs.readFileSync(new URL('../schemas/card.schema.json', import.meta.url), 'utf8')
);
const validateCard = new Ajv({ allErrors: true }).compile(cardSchema);

function tmpDataHome(prefix = 'vibe-recall-store-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const card = (over = {}) => ({
  schemaVersion: 1, repo: 'X', origin: 'local', path: '/p', remote: null,
  canonical: true, siblings: [], diverged: false, provenance: 'own',
  provenanceKnown: true, dedupVerified: true, head: 'abc', lastCommit: 1000,
  indexedAt: new Date().toISOString(), depth: 'shallow', stack: {}, deps: [],
  entrypoints: [], symbols: [], claims: [], gotchas: [], recallHits: 0,
  skippedSecretFiles: 0, skippedByFilename: 0, skippedByContent: 0,
  scanTruncated: false, truncatedBy: [], ...over
});

// --- engine/store.mjs -------------------------------------------------
// Every test here is driven by a crafted CLAUDE_PLUGIN_DATA pointing at a
// throwaway temp dir -- never the user's real data home.

describe('store.mjs', () => {
  test('readCards returns an empty array when no cards.json exists yet -- zero is a legitimate answer, not an error', () => {
    const dataHome = tmpDataHome();
    try {
      expect(fs.existsSync(path.join(dataHome, 'cards.json'))).toBe(false);
      expect(readCards({ CLAUDE_PLUGIN_DATA: dataHome })).toEqual([]);
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  test('saveCards then readCards round-trips the same cards', () => {
    const dataHome = tmpDataHome();
    try {
      const env = { CLAUDE_PLUGIN_DATA: dataHome };
      const cards = [card({ repo: 'A' }), card({ repo: 'B' })];
      const p = saveCards(cards, env);
      expect(fs.existsSync(p)).toBe(true);
      expect(readCards(env).map(c => c.repo)).toEqual(['A', 'B']);
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  test('saveCards creates a data home that does not exist yet, never silently skipping the write', () => {
    const parent = tmpDataHome();
    const nested = path.join(parent, 'does', 'not', 'exist', 'yet');
    try {
      const env = { CLAUDE_PLUGIN_DATA: nested };
      expect(fs.existsSync(nested)).toBe(false);
      const p = saveCards([card({ repo: 'Deep' })], env);
      expect(fs.existsSync(p)).toBe(true);
      expect(readCards(env).map(c => c.repo)).toEqual(['Deep']);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test('readCards throws with a named error on corrupt JSON instead of silently returning empty', () => {
    const dataHome = tmpDataHome();
    try {
      fs.writeFileSync(path.join(dataHome, 'cards.json'), '{this is not json');
      // Prove the file really is there and really is unparsable, so a throw
      // here is a real assertion and not just an artifact of a missing file.
      expect(fs.existsSync(path.join(dataHome, 'cards.json'))).toBe(true);
      expect(() => JSON.parse(fs.readFileSync(path.join(dataHome, 'cards.json'), 'utf8'))).toThrow();
      expect(() => readCards({ CLAUDE_PLUGIN_DATA: dataHome })).toThrow(/vibe-recall.*cards\.json/);
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  // resolveDataHome's tier 1 hands back CLAUDE_PLUGIN_DATA verbatim (see
  // engine/datahome.mjs), so on Windows it carries native backslashes, while
  // tier 2's legacy fallback already normalizes to forward slashes. A plain
  // path.join would leave the two tiers on different conventions; store.mjs
  // normalizes explicitly before joining so both land the same way.
  test('cardsPath normalizes a backslash-bearing CLAUDE_PLUGIN_DATA to forward slashes before joining', () => {
    const dataHome = tmpDataHome();
    try {
      // mkdtempSync on Windows returns a native, backslash-separated path --
      // exactly the unnormalized verbatim shape tier 1 hands back.
      const p = saveCards([], { CLAUDE_PLUGIN_DATA: dataHome });
      expect(p).not.toMatch(/\\/);
      // Not just a clean-looking string: the write actually landed at the
      // real, native location too.
      expect(fs.existsSync(path.join(dataHome, 'cards.json'))).toBe(true);
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  // Fix round 2, Finding 1: a UNC network path (\\server\share\...) cannot
  // survive path.posix.join -- it collapses a doubled leading slash down to
  // one, which fs then resolves root-relative to whatever drive the process
  // happens to be on. Reproduced live by an independent reviewer: saveCards
  // against a UNC CLAUDE_PLUGIN_DATA wrote to C:\server\share\... instead of
  // the network path, with no error anywhere. cardsPath now refuses outright.
  describe('UNC network paths are refused, never silently misdirected', () => {
    test('a backslash-form UNC path throws a named error, and nothing gets written to the misdirected local-drive location', () => {
      const uncPath = '\\\\fileserver\\share\\vibe-recall-data';
      // Pin exactly what the pre-fix code computed -- path.posix.join is the
      // step that actually collapses the doubled leading slash down to one,
      // which is the real mechanism of the misdirection the reviewer found.
      // A plain string concat (or path.resolve on the un-collapsed form)
      // does not reproduce it: Windows' own path.resolve understands "//"
      // as a UNC root and leaves it alone, so the bug only shows up once
      // path.posix.join has already thrown that information away.
      const collapsed = path.posix.join(uncPath.split(path.win32.sep).join('/'), 'cards.json');
      expect(collapsed.startsWith('//')).toBe(false); // prove the collapse really happened
      const preFixMisdirectedPath = path.resolve(collapsed);
      expect(preFixMisdirectedPath).not.toMatch(/^\\\\fileserver/i);
      expect(() => saveCards([], { CLAUDE_PLUGIN_DATA: uncPath })).toThrow(/vibe-recall.*UNC/i);
      expect(fs.existsSync(preFixMisdirectedPath)).toBe(false);
    });

    test('a forward-slash-form UNC path (//server/share/...) is refused the same way', () => {
      const uncPath = '//fileserver/share/vibe-recall-data';
      expect(() => saveCards([], { CLAUDE_PLUGIN_DATA: uncPath })).toThrow(/vibe-recall.*UNC/i);
    });

    test('a UNC path with a trailing separator is still recognized and refused', () => {
      const uncPath = '\\\\fileserver\\share\\vibe-recall-data\\';
      expect(() => saveCards([], { CLAUDE_PLUGIN_DATA: uncPath })).toThrow(/vibe-recall.*UNC/i);
    });

    // Fix round 3: the round-2 guard lived in store.mjs, checking
    // resolveDataHome's *output*. That worked for tier 1 (CLAUDE_PLUGIN_DATA
    // passes through unchanged) but missed tier 2 entirely: datahome.mjs's
    // own path.posix.join already collapses a UNC-rooted HOME/USERPROFILE
    // before store.mjs ever sees the result -- reproduced live by an
    // independent reviewer, who found a real cards.json written under
    // C:\server\share\... from a UNC USERPROFILE with no CLAUDE_PLUGIN_DATA
    // set. The guard now lives in datahome.mjs itself (see
    // tests/datahome.test.mjs for the direct coverage); this test proves
    // the fix holds end to end through the actual saveCards call path the
    // reviewer used, with no CLAUDE_PLUGIN_DATA in the env at all so tier 2
    // via USERPROFILE is what actually resolves.
    test('a UNC-style USERPROFILE (tier 2, no CLAUDE_PLUGIN_DATA) is refused before any write is attempted', () => {
      const uncPath = '\\\\fileserver\\share\\vibe-recall-data';
      // Replicate the exact pre-fix tier-2 + cardsPath pipeline to compute
      // what the real misdirected write location would have been -- proves
      // absence of the *specific* bug the reviewer found, not just "some
      // path doesn't exist." Verified against a standalone script before
      // being written into this test: it reproduces the reviewer's exact
      // C:\fileserver\share\... shape.
      const tier2Dir = path.posix.join(
        uncPath.split(path.win32.sep).join('/'),
        '.claude/plugins/data/vibe-recall'
      );
      const preFixMisdirectedPath = path.resolve(path.posix.join(tier2Dir, 'cards.json'));
      expect(preFixMisdirectedPath).not.toMatch(/^\\\\fileserver/i);

      const env = { USERPROFILE: uncPath }; // deliberately no CLAUDE_PLUGIN_DATA, no HOME
      expect(() => saveCards([], env)).toThrow(/vibe-recall.*USERPROFILE.*UNC/i);
      expect(fs.existsSync(preFixMisdirectedPath)).toBe(false);
    });

    test('an ordinary (non-UNC) path with a trailing separator still writes correctly -- the UNC check does not false-positive on it', () => {
      const dataHome = tmpDataHome();
      try {
        const withTrailingSep = dataHome.endsWith(path.sep) ? dataHome : dataHome + path.sep;
        const p = saveCards([card({ repo: 'Trailing' })], { CLAUDE_PLUGIN_DATA: withTrailingSep });
        expect(p).not.toMatch(/\/\//); // no doubled separator from the join
        expect(fs.existsSync(path.join(dataHome, 'cards.json'))).toBe(true);
        expect(readCards({ CLAUDE_PLUGIN_DATA: withTrailingSep }).map(c => c.repo)).toEqual(['Trailing']);
      } finally {
        fs.rmSync(dataHome, { recursive: true, force: true });
      }
    });
  });

  // Fix round 2, Minor 2: saveCards let raw fs errors (mkdirSync/writeFileSync)
  // escape unlabeled while readCards already wrapped its own fs failures with
  // vibe-recall context. Forcing a real ENOTDIR (a path segment is an actual
  // file, not a directory) rather than mocking fs, so this proves the real
  // failure mode, not an imagined one.
  test('saveCards throws a named error when the write fails, instead of letting a raw fs error escape unlabeled', () => {
    const tmpDir = tmpDataHome('vibe-recall-store-writefail-');
    try {
      const blockerFile = path.join(tmpDir, 'blocker');
      fs.writeFileSync(blockerFile, 'not a directory');
      // Prove the fixture really is a file (not a dir) before trusting the
      // mkdir-inside-a-file failure below.
      expect(fs.statSync(blockerFile).isFile()).toBe(true);
      const dataHome = path.join(blockerFile, 'nested');
      expect(() => saveCards([], { CLAUDE_PLUGIN_DATA: dataHome })).toThrow(/vibe-recall.*could not write cards/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('bumpHits increments recallHits only for named cards, leaves the rest untouched, and persists', () => {
    const dataHome = tmpDataHome();
    try {
      const env = { CLAUDE_PLUGIN_DATA: dataHome };
      saveCards([card({ repo: 'Hit', recallHits: 2 }), card({ repo: 'Miss', recallHits: 5 })], env);
      const result = bumpHits(['Hit'], env);
      expect(result.find(c => c.repo === 'Hit').recallHits).toBe(3);
      expect(result.find(c => c.repo === 'Miss').recallHits).toBe(5);
      expect(readCards(env).find(c => c.repo === 'Hit').recallHits).toBe(3);
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  test('bumpHits against a name the store no longer has (index changed since the sweep) does not throw and leaves survivors intact', () => {
    const dataHome = tmpDataHome();
    try {
      const env = { CLAUDE_PLUGIN_DATA: dataHome };
      saveCards([card({ repo: 'Survivor', recallHits: 1 })], env);
      expect(() => bumpHits(['Ghost', 'Survivor'], env)).not.toThrow();
      const result = readCards(env);
      expect(result.map(c => c.repo)).toEqual(['Survivor']);
      expect(result[0].recallHits).toBe(2);
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });
});

// --- engine/cli.mjs -----------------------------------------------------
// Real subprocess invocations. Every one that touches storage points
// CLAUDE_PLUGIN_DATA at a throwaway temp dir via env, never the real home.

describe('cli.mjs', () => {
  test('unknown subcommand exits non-zero with usage', () => {
    expect(() =>
      execFileSync('node', ['engine/cli.mjs', 'nonsense'], { stdio: 'pipe' })
    ).toThrow();
  });

  test('running with no subcommand at all also exits non-zero with usage', () => {
    expect(() =>
      execFileSync('node', ['engine/cli.mjs'], { stdio: 'pipe' })
    ).toThrow();
  });

  test('sweep against an empty index prints an honest no-prior-art line, not a crash or a blank screen', () => {
    const dataHome = tmpDataHome('vibe-recall-cli-sweep-empty-');
    try {
      const out = execFileSync('node', ['engine/cli.mjs', 'sweep', 'quantum', 'bicycle'], {
        encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataHome }
      });
      expect(out).toMatch(/No prior art.*quantum bicycle/);
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  test('sweep finds a seeded card, prints why, and persists the hit as a recallHits bump', () => {
    const dataHome = tmpDataHome('vibe-recall-cli-sweep-hit-');
    try {
      const env = { CLAUDE_PLUGIN_DATA: dataHome };
      saveCards([card({ repo: 'Findable', claims: ['stripe checkout flow'], recallHits: 0 })], env);
      const out = execFileSync('node', ['engine/cli.mjs', 'sweep', 'stripe', 'checkout'], {
        encoding: 'utf8', env: { ...process.env, ...env }
      });
      expect(out).toMatch(/Findable/);
      expect(readCards(env)[0].recallHits).toBe(1);
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  // sweep composition: match.mjs's rank() has supported ctx.selfRepo/
  // ctx.deps/ctx.includeForeign since the matcher was built and each is
  // unit-tested directly against rank() in tests/match.test.mjs -- but
  // cli.mjs's sweep() is the only real caller, and it passed a bare {}
  // until this fix round. These tests prove the wiring holds through the
  // real CLI/subprocess boundary, not just that rank() accepts the context
  // when handed one directly.
  describe('sweep composition: selfRepo/deps/includeForeign actually wired through the CLI', () => {
    // execFileSync's `cwd` option changes the *child's* working directory,
    // so the cli.mjs path passed as an argv entry must be absolute here --
    // 'engine/cli.mjs' would otherwise resolve relative to the child's new
    // cwd (the fixture repo dir), not this test file's own process.cwd().
    const CLI_PATH = path.resolve('engine/cli.mjs');

    test('sweep run from inside an indexed repo excludes that repo by default, and --include-self re-admits it', () => {
      const dataHome = tmpDataHome('vibe-recall-cli-sweep-self-');
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-cli-sweep-selfrepo-'));
      try {
        const cardPath = repoDir.split(path.sep).join('/');
        const env = { CLAUDE_PLUGIN_DATA: dataHome };
        saveCards([
          card({ repo: 'SelfRepo', path: cardPath, claims: ['stripe checkout flow'] }),
          card({ repo: 'OtherRepo', claims: ['stripe checkout flow'] })
        ], env);

        const withoutFlag = execFileSync('node', [CLI_PATH, 'sweep', 'stripe', 'checkout'], {
          encoding: 'utf8', cwd: repoDir, env: { ...process.env, ...env }
        });
        // Prove the searched set is non-empty before trusting the absence
        // assertion right after it. SelfRepo legitimately appears in the
        // exclusion notice ("(excluded: SelfRepo, ..."), so the absence
        // check is scoped to a HIT line (repo name at line start, padded),
        // not to the substring anywhere in the output.
        expect(withoutFlag).toMatch(/OtherRepo/);
        expect(withoutFlag).not.toMatch(/^SelfRepo\s/m);
        expect(withoutFlag).toMatch(/excluded: SelfRepo.*--include-self/);

        const withFlag = execFileSync('node', [CLI_PATH, 'sweep', '--include-self', 'stripe', 'checkout'], {
          encoding: 'utf8', cwd: repoDir, env: { ...process.env, ...env }
        });
        expect(withFlag).toMatch(/SelfRepo/);
      } finally {
        fs.rmSync(dataHome, { recursive: true, force: true });
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    // Reviewer-caught defect (fix round 2): the exclusion notice compared
    // against the FULL unsliced rank() output, but printing is capped at
    // the top 10 -- so it could tell a user "rerun with --include-self to
    // see it" for a card that would still rank 11th and stay invisible
    // after the rerun. The five tests above all use two or three matching
    // cards, so the bug shipped green; this is the test the reviewer said
    // would have caught it -- eleven real matches, the current repo weakest
    // among them.
    test('the exclusion notice does not promise a rerun result the cutoff would not actually show', () => {
      const dataHome = tmpDataHome('vibe-recall-cli-sweep-beyondcutoff-');
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-cli-sweep-beyondcutoff-repo-'));
      try {
        const cardPath = repoDir.split(path.sep).join('/');
        const env = { CLAUDE_PLUGIN_DATA: dataHome };
        // Ten cards match via `symbols` (weight 10, code-derived); SelfRepo
        // matches only via `claims` (weight 4, prose-derived) -- code beats
        // prose is already a proven match.mjs invariant (tests/match.test.mjs),
        // so SelfRepo is reliably the weakest of the eleven real matches,
        // not by a coin flip of tie-break/insertion order.
        const betterCards = Array.from({ length: 10 }, (_, i) =>
          card({ repo: `Better${i}`, symbols: ['ephemerisEngine'] }));
        saveCards([
          card({ repo: 'SelfRepo', path: cardPath, claims: ['uses an ephemeris library'] }),
          ...betterCards
        ], env);

        // Prove the ordering assumption directly, against the library
        // function itself, before trusting anything the CLI subprocess
        // prints below -- exactly the class of "test passes for the wrong
        // reason" the reviewer flagged twice already in this fix round.
        const withSelfIncluded = rank(readCards(env), 'ephemeris', { includeSelf: true, selfRepo: 'SelfRepo' });
        expect(withSelfIncluded).toHaveLength(11);
        expect(withSelfIncluded.slice(0, 10).map(h => h.card.repo)).not.toContain('SelfRepo');
        expect(withSelfIncluded[10].card.repo).toBe('SelfRepo');

        const out = execFileSync('node', [CLI_PATH, 'sweep', 'ephemeris'], {
          encoding: 'utf8', cwd: repoDir, env: { ...process.env, ...env }
        });
        // The ten stronger matches genuinely fill the visible list...
        expect(out.split('\n').filter(l => /^Better\d/.test(l))).toHaveLength(10);
        // ...so the notice must stay silent: --include-self would not move
        // SelfRepo into view, it would just add an invisible 11th entry.
        expect(out).not.toMatch(/excluded: SelfRepo/);
      } finally {
        fs.rmSync(dataHome, { recursive: true, force: true });
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    test('a card sharing deps with the current repo outranks one that does not, via ctx.deps derived from the self card', () => {
      const dataHome = tmpDataHome('vibe-recall-cli-sweep-deps-');
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-cli-sweep-selfdeps-'));
      try {
        const cardPath = repoDir.split(path.sep).join('/');
        const env = { CLAUDE_PLUGIN_DATA: dataHome };
        // Other is saved BEFORE Same, deliberately: with no real stack
        // affinity applied, Other and Same tie on score (identical claims,
        // no other differentiator), and Array.prototype.sort is stable, so
        // ties resolve to insertion order -- Other would come first purely
        // by accident of array position, and a test that inserted Same
        // first would "pass" even with ctx.deps never wired through (this
        // was caught live: the first version of this test used
        // [Same, Other] insertion order and stayed green against the
        // pre-fix code that never populates ctx.deps at all). Other-first
        // insertion means the only way Same can rank first is a real
        // stack-affinity bonus overriding insertion order.
        saveCards([
          card({ repo: 'Self', path: cardPath, deps: ['next'], claims: ['unrelated'] }),
          card({ repo: 'Other', deps: ['wpf'], claims: ['auth flow'] }),
          card({ repo: 'Same', deps: ['next'], claims: ['auth flow'] })
        ], env);
        const out = execFileSync('node', [CLI_PATH, 'sweep', 'auth', 'flow'], {
          encoding: 'utf8', cwd: repoDir, env: { ...process.env, ...env }
        });
        const lines = out.trim().split('\n').filter(l => /^(Same|Other)\s/.test(l));
        // Prove both real matches are present before trusting their order.
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(/^Same/);
      } finally {
        fs.rmSync(dataHome, { recursive: true, force: true });
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    test('--include-foreign re-admits a foreign card the CLI would otherwise always drop', () => {
      const dataHome = tmpDataHome('vibe-recall-cli-sweep-foreign-');
      try {
        const env = { CLAUDE_PLUGIN_DATA: dataHome };
        saveCards([
          card({ repo: 'FriendlyFork', provenance: 'foreign', claims: ['winui shell extension'] })
        ], env);
        const without = execFileSync('node', ['engine/cli.mjs', 'sweep', 'winui', 'shell'], {
          encoding: 'utf8', env: { ...process.env, ...env }
        });
        expect(without).toMatch(/No prior art/);
        expect(without).toMatch(/excluded: 1 foreign repo.*--include-foreign/);

        const withFlag = execFileSync('node', ['engine/cli.mjs', 'sweep', '--include-foreign', 'winui', 'shell'], {
          encoding: 'utf8', env: { ...process.env, ...env }
        });
        expect(withFlag).toMatch(/FriendlyFork/);
      } finally {
        fs.rmSync(dataHome, { recursive: true, force: true });
      }
    });

    test('running from a directory outside every indexed repo leaves self-exclusion off -- a legitimate no-op, not an error', () => {
      const dataHome = tmpDataHome('vibe-recall-cli-sweep-outside-');
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-cli-sweep-outside-cwd-'));
      try {
        const env = { CLAUDE_PLUGIN_DATA: dataHome };
        saveCards([card({ repo: 'Findable', claims: ['stripe checkout flow'] })], env);
        const out = execFileSync('node', [CLI_PATH, 'sweep', 'stripe', 'checkout'], {
          encoding: 'utf8', cwd: outsideDir, env: { ...process.env, ...env }
        });
        expect(out).toMatch(/Findable/);
        expect(out).not.toMatch(/excluded:/);
      } finally {
        fs.rmSync(dataHome, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    test('when the only real match is the current repo itself, sweep prints the honest zero-hit line AND names what got excluded', () => {
      const dataHome = tmpDataHome('vibe-recall-cli-sweep-selfonly-');
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-cli-sweep-selfonly-repo-'));
      try {
        const cardPath = repoDir.split(path.sep).join('/');
        const env = { CLAUDE_PLUGIN_DATA: dataHome };
        saveCards([card({ repo: 'OnlyMatch', path: cardPath, claims: ['quantum bicycle drivetrain'] })], env);
        const out = execFileSync('node', [CLI_PATH, 'sweep', 'quantum', 'bicycle'], {
          encoding: 'utf8', cwd: repoDir, env: { ...process.env, ...env }
        });
        expect(out).toMatch(/No prior art/);
        expect(out).toMatch(/excluded: OnlyMatch.*--include-self/);
      } finally {
        fs.rmSync(dataHome, { recursive: true, force: true });
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  test('queue against an empty index does not crash and prints nothing', () => {
    const dataHome = tmpDataHome('vibe-recall-cli-queue-empty-');
    try {
      const out = execFileSync('node', ['engine/cli.mjs', 'queue'], {
        encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataHome }
      });
      expect(out.trim()).toBe('');
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  test('queue lists shallow cards ordered by recallHits, deep cards excluded', () => {
    const dataHome = tmpDataHome('vibe-recall-cli-queue-');
    try {
      const env = { CLAUDE_PLUGIN_DATA: dataHome };
      saveCards([
        card({ repo: 'AlreadyDeep', depth: 'deep', recallHits: 99 }),
        card({ repo: 'Rare', recallHits: 1 }),
        card({ repo: 'Hot', recallHits: 9 })
      ], env);
      const out = execFileSync('node', ['engine/cli.mjs', 'queue'], {
        encoding: 'utf8', env: { ...process.env, ...env }
      });
      const lines = out.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/Hot/);
      expect(lines[1]).toMatch(/Rare/);
      expect(out).not.toMatch(/AlreadyDeep/);
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  test('vitals against an empty index reports honest zeroes, not a crash', () => {
    const dataHome = tmpDataHome('vibe-recall-cli-vitals-empty-');
    try {
      const out = execFileSync('node', ['engine/cli.mjs', 'vitals'], {
        encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataHome }
      });
      expect(out).toMatch(/repos indexed\s+0/);
      expect(out).toMatch(/foreign repos\s+0/);
      expect(out).toMatch(/scan truncated\s+0/);
      expect(out).toMatch(/deps present\s+yes/);
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  test('vitals surfaces what indexing hid: foreign repos by name, scanTruncated count, secret-skip counts', () => {
    const dataHome = tmpDataHome('vibe-recall-cli-vitals-');
    try {
      const env = { CLAUDE_PLUGIN_DATA: dataHome };
      saveCards([
        card({ repo: 'ForkedThing', provenance: 'foreign' }),
        card({ repo: 'AnotherFork', provenance: 'foreign' }),
        card({
          repo: 'OwnThing', provenance: 'own',
          skippedSecretFiles: 3, scanTruncated: true, truncatedBy: ['maxFilesRead']
        })
      ], env);
      const out = execFileSync('node', ['engine/cli.mjs', 'vitals'], {
        encoding: 'utf8', env: { ...process.env, ...env }
      });
      expect(out).toMatch(/repos indexed\s+3/);
      expect(out).toMatch(/foreign repos\s+2/);
      expect(out).toMatch(/ForkedThing/);
      expect(out).toMatch(/AnotherFork/);
      expect(out).toMatch(/scan truncated\s+1/);
      expect(out).toMatch(/secret-file skips\s+3/);
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  test('index without a config exits non-zero and names the setup step', () => {
    const dataHome = tmpDataHome('vibe-recall-cli-index-noconfig-');
    try {
      expect(() =>
        execFileSync('node', ['engine/cli.mjs', 'index'], {
          stdio: 'pipe', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataHome }
        })
      ).toThrow();
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  test('index builds schema-valid cards for a real local estate, respects the wall, and reports the count', () => {
    const estateRoot = makeEstate(RICH_SPEC);
    const dataHome = tmpDataHome('vibe-recall-cli-index-');
    try {
      fs.writeFileSync(path.join(dataHome, 'config.json'), JSON.stringify({
        schemaVersion: 1, estateRoot, walls: ['Acme']
      }));
      const out = execFileSync('node', ['engine/cli.mjs', 'index'], {
        encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataHome }
      });
      expect(out).toMatch(/indexed \d+ repos ->/);

      const saved = JSON.parse(fs.readFileSync(path.join(dataHome, 'cards.json'), 'utf8'));
      const names = saved.cards.map(c => c.repo).sort();
      // GoodApp + OtherApp only: Acme/SecretWork is walled, _scratch/Junk
      // is excluded by the leading underscore -- both proven elsewhere
      // (corpus-walls.test.mjs), this just proves the CLI wiring carries
      // the exclusion through end to end.
      expect(names).toEqual(['GoodApp', 'OtherApp']);
      expect(saved.cards.length).toBeGreaterThan(0);
      for (const c of saved.cards) {
        expect(validateCard(c)).toBe(true);
      }
    } finally {
      cleanEstate(estateRoot);
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  // Finding 1 (final whole-branch review): index() never read the existing
  // cards.json before rebuilding it -- it always rebuilt through
  // buildShallowCard (which hardcodes recallHits: 0, depth: 'shallow') and
  // handed the fresh array straight to saveCards, a whole-file replace. A
  // deep card written by /vibe-recall:deepen (real source read, features[]
  // recorded) silently reverted to shallow -- and its earned recallHits --
  // on the very next index run, which banner.mjs itself tells the user to
  // run whenever the index looks stale. This proves a repo's earned state
  // survives a real second index() pass over the same estate, not just that
  // a hand-built merge function behaves correctly in isolation.
  test('index preserves an existing deep card, its features, and its recallHits across a rebuild instead of reverting them', () => {
    const estateRoot = makeEstate(RICH_SPEC);
    const dataHome = tmpDataHome('vibe-recall-cli-index-preserve-');
    try {
      const env = { CLAUDE_PLUGIN_DATA: dataHome };
      fs.writeFileSync(path.join(dataHome, 'config.json'), JSON.stringify({
        schemaVersion: 1, estateRoot, walls: ['Acme']
      }));
      execFileSync('node', ['engine/cli.mjs', 'index'], {
        encoding: 'utf8', env: { ...process.env, ...env }
      });

      // Simulate exactly what the deepen skill does (skills/deepen/SKILL.md
      // step 5): read the real cards via the real store functions, promote
      // one to deep, attach features, bump recallHits -- never hand-edit
      // the JSON file.
      const firstPass = readCards(env);
      const target = firstPass.find(c => c.repo === 'GoodApp');
      expect(target).toBeDefined();
      expect(target.depth).toBe('shallow'); // prove the starting state is genuinely shallow
      target.depth = 'deep';
      target.features = [{
        name: 'stripe checkout', files: [{ path: 'src/lib/checkout.ts', lines: '1-1' }],
        contract: 'items, uid -> { url, id }', patterns: [], gotchas: [], wouldRedo: ''
      }];
      target.recallHits = 7;
      saveCards(firstPass, env);

      // Prove the deepened state genuinely landed before trusting the
      // post-reindex assertions below.
      const beforeReindex = readCards(env).find(c => c.repo === 'GoodApp');
      expect(beforeReindex.depth).toBe('deep');
      expect(beforeReindex.features).toHaveLength(1);
      expect(beforeReindex.recallHits).toBe(7);

      execFileSync('node', ['engine/cli.mjs', 'index'], {
        encoding: 'utf8', env: { ...process.env, ...env }
      });

      const afterReindex = readCards(env).find(c => c.repo === 'GoodApp');
      expect(afterReindex.depth).toBe('deep');
      expect(afterReindex.features).toEqual(target.features);
      expect(afterReindex.recallHits).toBe(7);
    } finally {
      cleanEstate(estateRoot);
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  // A repo that has genuinely disappeared from the estate (renamed away,
  // deleted, moved out from under the estate root) must still drop out of
  // the index -- carrying earned state forward must not turn into "cards
  // never die." Reuses the same fixture estate but excludes OtherApp from
  // the second index pass by removing it from disk between runs.
  test('a repo that genuinely disappears from the estate still drops out of the index, deep state or not', () => {
    const estateRoot = makeEstate(RICH_SPEC);
    const dataHome = tmpDataHome('vibe-recall-cli-index-drop-');
    try {
      const env = { CLAUDE_PLUGIN_DATA: dataHome };
      fs.writeFileSync(path.join(dataHome, 'config.json'), JSON.stringify({
        schemaVersion: 1, estateRoot, walls: ['Acme']
      }));
      execFileSync('node', ['engine/cli.mjs', 'index'], {
        encoding: 'utf8', env: { ...process.env, ...env }
      });
      const firstPass = readCards(env);
      expect(firstPass.map(c => c.repo)).toContain('OtherApp');

      fs.rmSync(path.join(estateRoot, 'OtherApp'), { recursive: true, force: true });
      execFileSync('node', ['engine/cli.mjs', 'index'], {
        encoding: 'utf8', env: { ...process.env, ...env }
      });
      const secondPass = readCards(env);
      expect(secondPass.map(c => c.repo)).not.toContain('OtherApp');
      expect(secondPass.map(c => c.repo)).toContain('GoodApp');
    } finally {
      cleanEstate(estateRoot);
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  test('index surfaces a diverged clone pair instead of swallowing it', () => {
    const estateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-cli-diverged-'));
    const dataHome = tmpDataHome('vibe-recall-cli-diverged-data-');
    try {
      const remoteUrl = 'https://github.com/e/Diverging.git';
      for (const name of ['Diverging', 'Diverging-copy']) {
        const repoPath = path.join(estateRoot, name);
        fs.mkdirSync(repoPath, { recursive: true });
        execSync('git init -q', { cwd: repoPath });
        execSync('git config user.email "test@vibe-recall.local"', { cwd: repoPath });
        execSync('git config user.name "Fixture Test"', { cwd: repoPath });
        // Unlike fixture-estate.mjs's repos (which never git-add real
        // content), this test needs an actual staged+committed file so the
        // two repos get genuinely different trees/heads. Pin autocrlf off
        // locally so that staging doesn't print a CRLF-conversion warning
        // to stderr on Windows -- noise, not signal, in this test's output.
        execSync('git config core.autocrlf false', { cwd: repoPath });
        execSync(`git remote add origin ${remoteUrl}`, { cwd: repoPath });
        fs.writeFileSync(path.join(repoPath, 'README.md'), `${name}\n`);
        execSync('git add -A', { cwd: repoPath });
        execSync('git commit -q -m init', { cwd: repoPath });
      }
      fs.writeFileSync(path.join(dataHome, 'config.json'), JSON.stringify({
        schemaVersion: 1, estateRoot, walls: ['Acme']
      }));
      const out = execFileSync('node', ['engine/cli.mjs', 'index'], {
        encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataHome }
      });
      expect(out).toMatch(/DIVERGED clone pairs/);
      expect(out).toMatch(/Diverging.*Diverging-copy|Diverging-copy.*Diverging/);
    } finally {
      fs.rmSync(estateRoot, { recursive: true, force: true });
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  // --- Final review, Finding B1: the carry-forward join key collides -------
  //
  // previousByRepo used to key solely on the bare basename (`c.repo`).
  // collapseDuplicates only merges entries sharing a normalized remote, so
  // two physically distinct repos with the same basename and different
  // remotes both reach the fresh card array carrying an identical `repo`
  // value. `new Map(...)` is last-write-wins, so both fresh cards look up
  // the SAME single prior entry on the next index() pass -- one repo's
  // earned recallHits/depth/features can attach to a repo that never earned
  // them. Reproduced here with two real git repos, same basename, different
  // remotes, nested under different parent directories (a shape corpus.mjs's
  // depth-bounded walk finds routinely on a real estate).
  test('two distinct repos sharing a basename with different remotes each keep their own recallHits/depth/features across a re-index', () => {
    const estateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-cli-basename-collision-'));
    const dataHome = tmpDataHome('vibe-recall-cli-basename-collision-data-');
    try {
      for (const [group, remoteUrl] of [
        ['GroupA', 'https://github.com/e/SharedA.git'],
        ['GroupB', 'https://github.com/e/SharedB.git']
      ]) {
        const repoPath = path.join(estateRoot, group, 'Shared');
        fs.mkdirSync(repoPath, { recursive: true });
        execSync('git init -q', { cwd: repoPath });
        execSync('git config user.email "test@vibe-recall.local"', { cwd: repoPath });
        execSync('git config user.name "Fixture Test"', { cwd: repoPath });
        execSync('git config core.autocrlf false', { cwd: repoPath });
        execSync(`git remote add origin ${remoteUrl}`, { cwd: repoPath });
        fs.writeFileSync(path.join(repoPath, 'README.md'), `${group}\n`);
        execSync('git add -A', { cwd: repoPath });
        execSync('git commit -q -m init', { cwd: repoPath });
      }

      const env = { CLAUDE_PLUGIN_DATA: dataHome };
      fs.writeFileSync(path.join(dataHome, 'config.json'), JSON.stringify({
        schemaVersion: 1, estateRoot, walls: ['Acme']
      }));

      execFileSync('node', ['engine/cli.mjs', 'index'], {
        encoding: 'utf8', env: { ...process.env, ...env }
      });
      const firstPass = readCards(env);
      // Prove the fixture genuinely produced two distinct cards sharing one
      // `repo` value before trusting anything below -- an empty or collapsed
      // result would make every later assertion vacuous.
      expect(firstPass.filter(c => c.repo === 'Shared')).toHaveLength(2);
      const groupACard = firstPass.find(c => c.remote && c.remote.includes('SharedA'));
      const groupBCard = firstPass.find(c => c.remote && c.remote.includes('SharedB'));
      expect(groupACard).toBeDefined();
      expect(groupBCard).toBeDefined();

      // Deepen only GroupA's Shared -- the same shape /vibe-recall:deepen
      // writes (real source read, features attached, recallHits bumped).
      // GroupB earns its own, separate recallHits history and stays shallow.
      groupACard.depth = 'deep';
      groupACard.features = [{
        name: 'group a feature', files: [{ path: 'README.md', lines: '1-1' }],
        contract: '', patterns: [], gotchas: [], wouldRedo: ''
      }];
      groupACard.recallHits = 9;
      groupBCard.recallHits = 3;
      saveCards(firstPass, env);

      execFileSync('node', ['engine/cli.mjs', 'index'], {
        encoding: 'utf8', env: { ...process.env, ...env }
      });
      const secondPass = readCards(env);
      const groupAAfter = secondPass.find(c => c.remote && c.remote.includes('SharedA'));
      const groupBAfter = secondPass.find(c => c.remote && c.remote.includes('SharedB'));

      expect(groupAAfter.depth).toBe('deep');
      expect(groupAAfter.features).toEqual(groupACard.features);
      expect(groupAAfter.recallHits).toBe(9);

      expect(groupBAfter.depth).toBe('shallow');
      expect(groupBAfter.features).toBeUndefined();
      expect(groupBAfter.recallHits).toBe(3);
    } finally {
      fs.rmSync(estateRoot, { recursive: true, force: true });
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  // --- Final review, Finding B2: origin-blind deep re-stamp -----------------
  //
  // Reproducing this end to end (a repo's local clone genuinely disappearing
  // while it stays enumerable through a configured GitHub account) would
  // require driving the real `gh` CLI, which is unsafe to fake in a test --
  // an attempt to shim a fake `gh` onto PATH for this suite still resolved
  // to the real, already-authenticated `gh` on this machine and made a live
  // network call. applyCarryForward is exported from engine/cli.mjs for
  // exactly this reason: these tests drive the *exact* merge function
  // index() calls, directly, against hand-built fresh/prior pairs -- not a
  // reimplementation of the logic, and no subprocess or network involved.
  describe('applyCarryForward -- the exact merge logic index() uses', () => {
    test('a repo demoted from deep-while-local to remote-only does not keep depth: "deep" or stale features', () => {
      const prior = card({
        repo: 'Demoted', origin: 'local', path: '/estate/Demoted',
        remote: 'https://github.com/e/Demoted.git', depth: 'deep', recallHits: 5,
        features: [{
          name: 'stale feature', files: [{ path: 'src/old.ts', lines: '1-1' }],
          contract: '', patterns: [], gotchas: [], wouldRedo: ''
        }]
      });
      // buildShallowCard's remote-only branch shape exactly: origin:
      // 'remote', path: null, depth: 'shallow-remote', recallHits: 0, and no
      // `features` key at all -- the local clone that earned 'deep' is gone.
      const fresh = card({
        repo: 'Demoted', origin: 'remote', path: null,
        remote: 'https://github.com/e/Demoted.git', depth: 'shallow-remote', recallHits: 0
      });
      delete fresh.features;

      const merged = applyCarryForward(fresh, prior);

      expect(merged.depth).toBe('shallow-remote');
      expect(merged.features).toBeUndefined();
      // recallHits is demand history, not origin-scoped -- it survives the
      // origin change even though depth/features do not.
      expect(merged.recallHits).toBe(5);
    });

    test('the ordinary case (origin unchanged) still carries depth/features forward -- the origin guard does not over-fire', () => {
      const priorFeatures = [{
        name: 'steady feature', files: [{ path: 'src/steady.ts', lines: '1-1' }],
        contract: '', patterns: [], gotchas: [], wouldRedo: ''
      }];
      const prior = card({ repo: 'Steady', origin: 'local', depth: 'deep', recallHits: 7, features: priorFeatures });
      const fresh = card({ repo: 'Steady', origin: 'local', depth: 'shallow', recallHits: 0 });

      const merged = applyCarryForward(fresh, prior);

      expect(merged.depth).toBe('deep');
      expect(merged.features).toEqual(priorFeatures);
      expect(merged.recallHits).toBe(7);
    });

    test('a shallow prior (never deepened) never carries depth/features forward, regardless of origin', () => {
      const prior = card({ repo: 'NeverDeepened', origin: 'local', depth: 'shallow', recallHits: 2 });
      const fresh = card({ repo: 'NeverDeepened', origin: 'local', depth: 'shallow', recallHits: 0 });

      const merged = applyCarryForward(fresh, prior);

      expect(merged.depth).toBe('shallow');
      expect(merged.features).toBeUndefined();
      expect(merged.recallHits).toBe(2);
    });

    test('no prior entry at all leaves the fresh card untouched', () => {
      const fresh = card({ repo: 'BrandNew', origin: 'local', depth: 'shallow', recallHits: 0 });

      const merged = applyCarryForward(fresh, undefined);

      expect(merged).toBe(fresh);
      expect(merged.depth).toBe('shallow');
      expect(merged.recallHits).toBe(0);
    });
  });

  // The UserPromptSubmit hook's prompt-delivery contract went through one
  // wrong guess ($CLAUDE_USER_PROMPT, an env var that does not exist -- see
  // engine/cli.mjs's readPromptFromStdin comment) before resolving to stdin
  // JSON with the prompt on a "user_input" field, corroborated from two
  // independent sources (a Claude Code specialist agent's read of the
  // reference, and vibe-wrap's shipped SessionEnd hook using the same
  // snake_case stdin-JSON convention). These prove the resolved contract
  // and its fallbacks actually work end to end through the real subprocess
  // boundary the hook will use, not just that the helper function looks
  // right in isolation.
  describe('banner subcommand -- prompt-delivery contract, now resolved but still defensive', () => {
    test('reads the prompt from a real UserPromptSubmit-shaped stdin payload ("user_input" field)', () => {
      const dataHome = tmpDataHome('vibe-recall-cli-banner-realshape-');
      try {
        const env = { CLAUDE_PLUGIN_DATA: dataHome };
        saveCards([card({ repo: 'Findable', claims: ['stripe checkout flow'], indexedAt: new Date().toISOString() })], env);
        // The full documented shape, not just the one field this code cares
        // about -- proves the extra fields (session_id, prompt_id,
        // transcript_path, cwd, permission_mode, hook_event_name) are
        // harmlessly ignored rather than confusing the parse.
        const payload = {
          session_id: 'abc123',
          prompt_id: 'p1',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: process.cwd(),
          permission_mode: 'default',
          hook_event_name: 'UserPromptSubmit',
          user_input: 'build a stripe checkout for this app'
        };
        const out = execFileSync('node', ['engine/cli.mjs', 'banner'], {
          encoding: 'utf8',
          input: JSON.stringify(payload),
          env: { ...process.env, ...env }
        });
        expect(out).toMatch(/you have built this before/);
        expect(out).toMatch(/Findable/);
      } finally {
        fs.rmSync(dataHome, { recursive: true, force: true });
      }
    });

    test('still reads the "prompt" field as a fallback candidate, in case the real contract differs from what was corroborated', () => {
      const dataHome = tmpDataHome('vibe-recall-cli-banner-stdin-');
      try {
        const env = { CLAUDE_PLUGIN_DATA: dataHome };
        saveCards([card({ repo: 'Findable', claims: ['stripe checkout flow'], indexedAt: new Date().toISOString() })], env);
        const out = execFileSync('node', ['engine/cli.mjs', 'banner'], {
          encoding: 'utf8',
          input: JSON.stringify({ prompt: 'build a stripe checkout for this app' }),
          env: { ...process.env, ...env }
        });
        expect(out).toMatch(/you have built this before/);
        expect(out).toMatch(/Findable/);
      } finally {
        fs.rmSync(dataHome, { recursive: true, force: true });
      }
    });

    test('falls back to the raw stdin text as the prompt when stdin is not JSON', () => {
      const dataHome = tmpDataHome('vibe-recall-cli-banner-rawstdin-');
      try {
        // Empty index -- the point here is only that "build a dashboard for
        // the fleet" (delivered as plain, non-JSON stdin text) still reaches
        // hasBuildIntent and produces the no-index-yet banner, proving the
        // raw-text fallback path actually runs rather than silently
        // swallowing unparseable stdin.
        const out = execFileSync('node', ['engine/cli.mjs', 'banner'], {
          encoding: 'utf8',
          input: 'build a dashboard for the fleet',
          env: { ...process.env, CLAUDE_PLUGIN_DATA: dataHome }
        });
        expect(out).toMatch(/no index yet/);
      } finally {
        fs.rmSync(dataHome, { recursive: true, force: true });
      }
    });

    test('a non-build stdin prompt produces no output at all', () => {
      const dataHome = tmpDataHome('vibe-recall-cli-banner-silent-');
      try {
        const env = { CLAUDE_PLUGIN_DATA: dataHome };
        saveCards([card({ repo: 'Findable', claims: ['stripe checkout flow'] })], env);
        const out = execFileSync('node', ['engine/cli.mjs', 'banner'], {
          encoding: 'utf8',
          input: JSON.stringify({ prompt: 'what time is it' }),
          env: { ...process.env, ...env }
        });
        expect(out.trim()).toBe('');
      } finally {
        fs.rmSync(dataHome, { recursive: true, force: true });
      }
    });

    test('an explicit argv prompt still wins over stdin -- manual invocation stays usable', () => {
      const dataHome = tmpDataHome('vibe-recall-cli-banner-argv-');
      try {
        const out = execFileSync('node', ['engine/cli.mjs', 'banner', 'build', 'a', 'dashboard'], {
          encoding: 'utf8',
          input: JSON.stringify({ prompt: 'what time is it' }), // must be ignored
          env: { ...process.env, CLAUDE_PLUGIN_DATA: dataHome }
        });
        expect(out).toMatch(/no index yet/);
      } finally {
        fs.rmSync(dataHome, { recursive: true, force: true });
      }
    });

    // readCards throws a named error on corrupt JSON (tests/cli.test.mjs's
    // store.mjs describe block above covers that directly). banner.mjs
    // catches around that call and returns null rather than letting the
    // exception propagate -- a hook that crashes on every prompt because
    // one index file went bad is worse than a hook that just says nothing.
    // This proves that holds through the real CLI/subprocess boundary, exit
    // code included, not just inside banner.mjs's own try/catch.
    test('a corrupt cards.json degrades to silence, not a crash -- a throwing hook is worse than a silent one', () => {
      const dataHome = tmpDataHome('vibe-recall-cli-banner-corrupt-');
      try {
        fs.mkdirSync(dataHome, { recursive: true });
        fs.writeFileSync(path.join(dataHome, 'cards.json'), '{this is not json');
        const out = execFileSync('node', ['engine/cli.mjs', 'banner'], {
          encoding: 'utf8',
          input: JSON.stringify({ prompt: 'build a stripe checkout for this app' }),
          env: { ...process.env, CLAUDE_PLUGIN_DATA: dataHome }
        });
        expect(out.trim()).toBe('');
      } finally {
        fs.rmSync(dataHome, { recursive: true, force: true });
      }
    });

    // UserPromptSubmit hook semantics: exit 2 blocks AND ERASES the user's
    // typed prompt; any other nonzero exit is a non-blocking error but still
    // unwanted. These assert the exit code explicitly via spawnSync's
    // `status` -- not just "nothing crashed" or "output looked right" --
    // because that is the actual thing the hook contract cares about, and a
    // command that happens to print nothing can still have exited nonzero.
    describe('exit code -- must be 0 on every path, never the prompt-erasing 2', () => {
      test('malformed (truncated, non-JSON) stdin that still carries build-intent wording exits 0', () => {
        const dataHome = tmpDataHome('vibe-recall-cli-banner-malformed-');
        try {
          // Deliberately broken JSON -- JSON.parse fails, so this exercises
          // the raw-text fallback with content that still trips
          // hasBuildIntent, carrying the run all the way through readCards
          // and rank() rather than short-circuiting on the first check.
          const malformed = '{"user_input": "please build a new checkout flow" not valid json here';
          const result = spawnSync('node', ['engine/cli.mjs', 'banner'], {
            encoding: 'utf8',
            input: malformed,
            env: { ...process.env, CLAUDE_PLUGIN_DATA: dataHome }
          });
          expect(result.status).toBe(0);
        } finally {
          fs.rmSync(dataHome, { recursive: true, force: true });
        }
      });

      // The three tests around this one all route through failure paths
      // banner.mjs already caught internally (readPromptFromStdin's own
      // JSON.parse try/catch, or its readCards-scoped try/catch) -- they'd
      // pass even without the new outer try/catch in the CLI's banner
      // command. This one doesn't: a ranked card whose "repo" isn't a
      // string throws inside banner.mjs's line-formatting step
      // (`h.card.repo.padEnd(...)`), which sits *outside* that function's
      // own try/catch. Only the new outer net in engine/cli.mjs catches
      // this. Confirmed by temporarily removing that outer try/catch and
      // watching this specific test go red before restoring it.
      test('a malformed card shape that breaks the banner\'s own formatting still exits 0', () => {
        const dataHome = tmpDataHome('vibe-recall-cli-banner-malformedcard-');
        try {
          const env = { CLAUDE_PLUGIN_DATA: dataHome };
          saveCards([card({ repo: null, claims: ['stripe checkout flow'], indexedAt: new Date().toISOString() })], env);
          const result = spawnSync('node', ['engine/cli.mjs', 'banner'], {
            encoding: 'utf8',
            input: JSON.stringify({ user_input: 'build a stripe checkout for this app' }),
            env: { ...process.env, ...env }
          });
          expect(result.status).toBe(0);
        } finally {
          fs.rmSync(dataHome, { recursive: true, force: true });
        }
      });

      test('a build-intent prompt against a missing index exits 0', () => {
        const dataHome = tmpDataHome('vibe-recall-cli-banner-noindex-exit-');
        try {
          const result = spawnSync('node', ['engine/cli.mjs', 'banner'], {
            encoding: 'utf8',
            input: JSON.stringify({ user_input: 'build a dashboard for the fleet' }),
            env: { ...process.env, CLAUDE_PLUGIN_DATA: dataHome }
          });
          expect(result.status).toBe(0);
          expect(result.stdout).toMatch(/no index yet/);
        } finally {
          fs.rmSync(dataHome, { recursive: true, force: true });
        }
      });

      test('a corrupt index exits 0, not just prints nothing', () => {
        const dataHome = tmpDataHome('vibe-recall-cli-banner-corrupt-exit-');
        try {
          fs.mkdirSync(dataHome, { recursive: true });
          fs.writeFileSync(path.join(dataHome, 'cards.json'), '{this is not json');
          const result = spawnSync('node', ['engine/cli.mjs', 'banner'], {
            encoding: 'utf8',
            input: JSON.stringify({ user_input: 'build a stripe checkout for this app' }),
            env: { ...process.env, CLAUDE_PLUGIN_DATA: dataHome }
          });
          expect(result.status).toBe(0);
        } finally {
          fs.rmSync(dataHome, { recursive: true, force: true });
        }
      });
    });
  });
});
