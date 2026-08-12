import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { banner, hasBuildIntent, isStale } from '../engine/banner.mjs';
import { saveCards } from '../engine/store.mjs';

const FORBIDDEN = [
  'child_process', 'node:child_process',
  'http', 'node:http', 'https', 'node:https',
  'net', 'node:net', 'dgram', 'node:dgram'
];

// Four patterns, not one: a static `import ... from '...'` (optionally with
// no `from` at all, for a bare side-effect import) is what the original
// regex caught. It missed two other ways a specifier can enter a module --
// `await import('...')` (dynamic, can appear anywhere on a line, not just
// at the start) and `export { x } from '...'` (a re-export) -- both of
// which are real ways to reach node:child_process without ever writing a
// line that starts with the word "import". A budget test that only sees
// static leading-`import` lines is blind to both, which is worse than an
// obviously-missing check: it looks like coverage.
const IMPORT_PATTERNS = [
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s[^'"()]*?from\s*['"]([^'"]+)['"]/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\bexport\s[^'"()]*?from\s*['"]([^'"]+)['"]/g
];

function allSpecifiers(body) {
  const specs = [];
  for (const re of IMPORT_PATTERNS) {
    for (const m of body.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

function importGraph(entry, seen = new Set()) {
  const abs = path.resolve(entry);
  if (seen.has(abs)) return seen;
  seen.add(abs);
  const body = fs.readFileSync(abs, 'utf8');
  for (const spec of allSpecifiers(body)) {
    if (spec.startsWith('.')) importGraph(path.join(path.dirname(abs), spec), seen);
  }
  return seen;
}

function specifiersOf(file) {
  return allSpecifiers(fs.readFileSync(file, 'utf8'));
}

test('build intent detection is narrow', () => {
  expect(hasBuildIntent("let's add stripe checkout to Reel-Battles")).toBe(true);
  expect(hasBuildIntent('build a dashboard for the fleet')).toBe(true);
  expect(hasBuildIntent('what did that error mean')).toBe(false);
  expect(hasBuildIntent('run the tests')).toBe(false);
});

// The pattern's original shape (trigger word + optional article + any word)
// collapsed to "trigger word, whitespace, any word" whenever the article
// was absent, which is most ordinary conversation. Both of the first two
// cases here were demonstrated live as real false positives; the last two
// are the same class ("trigger word immediately followed by a preposition
// or a diagnostic noun, no article") named explicitly as required negative
// coverage. All four must stay false, and the two positives in the test
// above must stay true -- this is the same heuristic being narrowed, not
// replaced.
test('build intent detection does not fire on ordinary conversation that merely contains a trigger word', () => {
  expect(hasBuildIntent('what did you add to the config')).toBe(false);
  expect(hasBuildIntent('I need to understand this build failure')).toBe(false);
  expect(hasBuildIntent('the build failed')).toBe(false);
  expect(hasBuildIntent('add it to the list')).toBe(false);
});

test('staleness at hook time is time-based, never HEAD-based', () => {
  const now = new Date('2026-08-11T00:00:00Z');
  expect(isStale({ indexedAt: '2026-08-10T00:00:00Z' }, 14, now)).toBe(false);
  expect(isStale({ indexedAt: '2026-01-01T00:00:00Z' }, 14, now)).toBe(true);
  expect(isStale({}, 14, now)).toBe(true);
});

// Walks engine/hook.mjs, not engine/banner.mjs -- hooks/hooks.json spawns
// hook.mjs, so that is the graph actually loaded on every UserPromptSubmit.
// Walking banner.mjs alone (the original shape of this test) proved a
// budget the hook wasn't bound by: cli.mjs, which used to be what the hook
// ran, pulls in config.mjs/corpus.mjs/remote.mjs/cards.mjs at import time --
// all four of which reach node:child_process -- and none of that was ever
// visible to a test that only ever looked at banner.mjs's own graph.
test('nothing in the hook import graph can spawn a process or open a socket', () => {
  const graph = importGraph('engine/hook.mjs');
  const offenders = [];
  for (const file of graph) {
    for (const spec of specifiersOf(file)) {
      if (FORBIDDEN.includes(spec)) offenders.push(`${path.basename(file)} -> ${spec}`);
    }
  }
  expect(offenders).toEqual([]);
});

test('the hook graph never imports the corpus, card, remote, or config builders', () => {
  const names = [...importGraph('engine/hook.mjs')].map(f => path.basename(f));
  expect(names).not.toContain('corpus.mjs');
  expect(names).not.toContain('cards.mjs');
  expect(names).not.toContain('remote.mjs');
  expect(names).not.toContain('config.mjs');
});

test('a non-build prompt produces nothing', () => {
  expect(banner('what time is it')).toBeNull();
});

// Finding 3 (final whole-branch review), direct unit-level coverage:
// banner() itself must accept and act on a cwd, not just call rank() with a
// bare {}. This exercises banner() directly (no subprocess), the same
// function hook.mjs's real UserPromptSubmit entry point calls -- proving
// the fix at the function-signature level, independent of hook.mjs's own
// stdin-payload wiring (covered separately in tests/hook.test.mjs).
function tmpDataHome(prefix = 'vibe-recall-banner-cwd-') {
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

test('banner(prompt, env, cwd) excludes the card whose path matches cwd -- self-exclusion wired at the function level', () => {
  const dataHome = tmpDataHome();
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-banner-cwd-selfrepo-'));
  try {
    const cardPath = repoDir.split(path.sep).join('/');
    const env = { CLAUDE_PLUGIN_DATA: dataHome };
    saveCards([
      card({ repo: 'SelfRepo', path: cardPath, claims: ['add a card indexer for the estate'] }),
      card({ repo: 'OtherRepo', claims: ['add a card indexer for the estate'] })
    ], env);
    const out = banner('we need to add a card indexer for the estate', env, repoDir);
    // Prove the query genuinely matches something real before trusting the
    // self-exclusion assertion right after it.
    expect(out).toMatch(/you have built this before/);
    expect(out).toMatch(/OtherRepo/);
    expect(out).not.toMatch(/SelfRepo/);
  } finally {
    fs.rmSync(dataHome, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('banner(prompt, env, cwd) with cwd outside every indexed repo applies no exclusion -- a legitimate no-op', () => {
  const dataHome = tmpDataHome();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-banner-cwd-outside-'));
  try {
    const env = { CLAUDE_PLUGIN_DATA: dataHome };
    saveCards([card({ repo: 'Findable', claims: ['add a card indexer for the estate'] })], env);
    const out = banner('we need to add a card indexer for the estate', env, outsideDir);
    expect(out).toMatch(/Findable/);
  } finally {
    fs.rmSync(dataHome, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
