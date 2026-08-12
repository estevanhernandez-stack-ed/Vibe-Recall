import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { saveCards } from '../engine/store.mjs';

// engine/hook.mjs is what hooks/hooks.json actually spawns (see its own
// header comment, and tests/banner-budget.test.mjs's import-graph walk,
// for why it exists as a separate, thinner entry point from engine/cli.mjs).
// tests/cli.test.mjs already proves the *contract logic* -- stdin-JSON
// field candidates, raw-text fallback, exit-0 guarantees -- through
// cli.mjs's own `banner` subcommand, which is the manual-testing path.
// These tests prove that same behavior actually holds through the real
// entry point the hook runs, not just its manual-testing sibling. A thin
// entry point that was never itself exercised end to end would repeat
// exactly the mistake Finding 1 called out: a test proving a budget (or a
// behavior) that isn't the one actually bound by the hook.

function tmpDataHome(prefix = 'vibe-recall-hook-') {
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

describe('hook.mjs -- the real UserPromptSubmit entry point', () => {
  test('a real UserPromptSubmit-shaped stdin payload ("user_input" field) yields a banner', () => {
    const dataHome = tmpDataHome();
    try {
      const env = { CLAUDE_PLUGIN_DATA: dataHome };
      saveCards([card({ repo: 'Findable', claims: ['stripe checkout flow'], indexedAt: new Date().toISOString() })], env);
      const payload = {
        session_id: 'abc123',
        prompt_id: 'p1',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: process.cwd(),
        permission_mode: 'default',
        hook_event_name: 'UserPromptSubmit',
        user_input: 'build a stripe checkout for this app'
      };
      const out = execFileSync('node', ['engine/hook.mjs'], {
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

  test('a non-build prompt produces no output', () => {
    const dataHome = tmpDataHome();
    try {
      const env = { CLAUDE_PLUGIN_DATA: dataHome };
      saveCards([card({ repo: 'Findable', claims: ['stripe checkout flow'] })], env);
      const out = execFileSync('node', ['engine/hook.mjs'], {
        encoding: 'utf8',
        input: JSON.stringify({ user_input: 'what time is it' }),
        env: { ...process.env, ...env }
      });
      expect(out.trim()).toBe('');
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  test('a build-intent prompt against a missing index prints the no-index-yet line and exits 0', () => {
    const dataHome = tmpDataHome();
    try {
      const result = spawnSync('node', ['engine/hook.mjs'], {
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

  test('malformed (non-JSON) stdin falls back to raw text and still exits 0', () => {
    const dataHome = tmpDataHome();
    try {
      const result = spawnSync('node', ['engine/hook.mjs'], {
        encoding: 'utf8',
        input: '{"user_input": "please build a new checkout flow" not valid json here',
        env: { ...process.env, CLAUDE_PLUGIN_DATA: dataHome }
      });
      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  test('a corrupt index degrades to silence and exits 0, not a crash', () => {
    const dataHome = tmpDataHome();
    try {
      fs.mkdirSync(dataHome, { recursive: true });
      fs.writeFileSync(path.join(dataHome, 'cards.json'), '{this is not json');
      const result = spawnSync('node', ['engine/hook.mjs'], {
        encoding: 'utf8',
        input: JSON.stringify({ user_input: 'build a stripe checkout for this app' }),
        env: { ...process.env, CLAUDE_PLUGIN_DATA: dataHome }
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('');
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  // Same class of gap as engine/cli.mjs's malformed-card test: a ranked
  // card whose "repo" isn't a string throws inside banner.mjs's own
  // line-formatting step, outside banner.mjs's readCards-scoped try/catch.
  // hook.mjs's outer try/catch in main() is what has to catch this one.
  test('a malformed card shape that breaks the banner\'s own formatting still exits 0', () => {
    const dataHome = tmpDataHome();
    try {
      const env = { CLAUDE_PLUGIN_DATA: dataHome };
      saveCards([card({ repo: null, claims: ['stripe checkout flow'], indexedAt: new Date().toISOString() })], env);
      const result = spawnSync('node', ['engine/hook.mjs'], {
        encoding: 'utf8',
        input: JSON.stringify({ user_input: 'build a stripe checkout for this app' }),
        env: { ...process.env, ...env }
      });
      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  // Finding 3 (final whole-branch review): banner.mjs's real hook path
  // called rank(cards, prompt, {}) -- an always-empty context. cli.mjs's
  // sweep() correctly derives ctx.selfRepo/ctx.deps from cwd, but the
  // banner never did, so on the highest-traffic surface in the plugin
  // (every UserPromptSubmit), self-exclusion and stack affinity were both
  // dead: the banner could -- and, reproduced live against the real
  // 83-card index, did -- list the very repo the user is standing in under
  // "you have built this before." The UserPromptSubmit payload already
  // carries cwd; this proves it actually gets threaded from hook.mjs into
  // banner(), matching cards against the payload's cwd the same way
  // cli.mjs's sweep() matches against process.cwd().
  test('threads cwd from the UserPromptSubmit payload into banner() so self-exclusion applies on the hook path, not just sweep', () => {
    const dataHome = tmpDataHome();
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-hook-selfrepo-'));
    try {
      const cardPath = repoDir.split(path.sep).join('/');
      const env = { CLAUDE_PLUGIN_DATA: dataHome };
      saveCards([
        card({ repo: 'SelfRepo', path: cardPath, claims: ['add a card indexer for the estate'] }),
        card({ repo: 'OtherRepo', claims: ['add a card indexer for the estate'] })
      ], env);
      const payload = { cwd: repoDir, user_input: 'we need to add a card indexer for the estate' };
      const out = execFileSync('node', ['engine/hook.mjs'], {
        encoding: 'utf8',
        input: JSON.stringify(payload),
        env: { ...process.env, ...env }
      });
      // Prove the query genuinely matches something real before trusting
      // the self-exclusion assertion right after it.
      expect(out).toMatch(/you have built this before/);
      expect(out).toMatch(/OtherRepo/);
      expect(out).not.toMatch(/SelfRepo/);
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  // Stack affinity is the other half of ctx that a bare {} kills. A card
  // sharing deps with the self card's stack must still outrank one that
  // doesn't, exactly as cli.mjs's sweep() already proves for the CLI path
  // (tests/cli.test.mjs, "a card sharing deps with the current repo
  // outranks one that does not").
  test('a card sharing deps with the repo at cwd outranks one that does not, on the hook path', () => {
    const dataHome = tmpDataHome();
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-hook-selfdeps-'));
    try {
      const cardPath = repoDir.split(path.sep).join('/');
      const env = { CLAUDE_PLUGIN_DATA: dataHome };
      saveCards([
        card({ repo: 'Self', path: cardPath, deps: ['next'], claims: ['unrelated'] }),
        card({ repo: 'Other', deps: ['wpf'], claims: ['auth flow'] }),
        card({ repo: 'Same', deps: ['next'], claims: ['auth flow'] })
      ], env);
      const payload = { cwd: repoDir, user_input: 'we need to build an auth flow' };
      const out = execFileSync('node', ['engine/hook.mjs'], {
        encoding: 'utf8',
        input: JSON.stringify(payload),
        env: { ...process.env, ...env }
      });
      const lines = out.split('\n').filter(l => /^\s*(Same|Other)\s/.test(l));
      // Prove both real matches are present before trusting their order.
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/Same/);
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('a TTY-less empty stdin (no payload at all) exits 0 without hanging', () => {
    const dataHome = tmpDataHome();
    try {
      const result = spawnSync('node', ['engine/hook.mjs'], {
        encoding: 'utf8',
        input: '',
        env: { ...process.env, CLAUDE_PLUGIN_DATA: dataHome },
        timeout: 5000
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('');
    } finally {
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });
});
