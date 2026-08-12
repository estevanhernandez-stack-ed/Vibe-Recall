import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { normalizeRemote, collapseDuplicates, enumerateLocal } from '../engine/corpus.mjs';

test('remote URL variants normalize to one key', () => {
  const k = 'github.com/e/App';
  expect(normalizeRemote('https://github.com/e/App.git')).toBe(k);
  expect(normalizeRemote('git@github.com:e/App.git')).toBe(k);
  expect(normalizeRemote('https://GitHub.com/e/App/')).toBe(k);
});

test('explicit ssh:// scheme with git@ converts correctly', () => {
  const k = 'github.com/owner/repo';
  expect(normalizeRemote('ssh://git@github.com/owner/repo.git')).toBe(k);
  expect(normalizeRemote('https://github.com/owner/repo.git')).toBe(k);
});

test('nested group paths preserve full hierarchy', () => {
  const k1 = 'gitlab.company.com/team-a/subteam/project-one';
  const k2 = 'gitlab.company.com/team-a/subteam/project-two';
  expect(normalizeRemote('https://gitlab.company.com/team-a/subteam/project-one.git')).toBe(k1);
  expect(normalizeRemote('https://gitlab.company.com/team-a/subteam/project-two.git')).toBe(k2);
  expect(k1).not.toBe(k2);
});

test('same remote, same head: collapses to one canonical with the sibling named', () => {
  const out = collapseDuplicates([
    { name: 'App', remote: 'https://github.com/e/App.git', head: 'aaa', lastCommit: 200, remoteReadFailed: false },
    { name: 'App-copy', remote: 'git@github.com:e/App.git', head: 'aaa', lastCommit: 100, remoteReadFailed: false }
  ]);
  expect(out).toHaveLength(1);
  expect(out[0].name).toBe('App');
  expect(out[0].siblings).toEqual(['App-copy']);
  expect(out[0].diverged).toBe(false);
  expect(out[0].dedupVerified).toBe(true);
});

test('same remote, different heads: flags diverged instead of silently picking', () => {
  const out = collapseDuplicates([
    { name: 'Hourglass', remote: 'https://github.com/e/S.git', head: 'aaa', lastCommit: 200, remoteReadFailed: false },
    { name: 'Hourglass_alt', remote: 'https://github.com/e/S.git', head: 'bbb', lastCommit: 100, remoteReadFailed: false }
  ]);
  expect(out).toHaveLength(1);
  expect(out[0].diverged).toBe(true);
  expect(out[0].siblings).toEqual(['Hourglass_alt']);
  expect(out[0].dedupVerified).toBe(true);
});

test('a repo with no remote is never collapsed into another', () => {
  const out = collapseDuplicates([
    { name: 'A', remote: null, head: 'aaa', lastCommit: 1, remoteReadFailed: false },
    { name: 'B', remote: null, head: 'bbb', lastCommit: 2, remoteReadFailed: false }
  ]);
  expect(out).toHaveLength(2);
});

test('a repo with remoteReadFailed: true emits dedupVerified: false and preserves the flag', () => {
  const out = collapseDuplicates([
    { name: 'X', remote: null, head: 'aaa', lastCommit: 1, remoteReadFailed: true }
  ]);
  expect(out).toHaveLength(1);
  expect(out[0].dedupVerified).toBe(false);
  expect(out[0].remoteReadFailed).toBe(true);
});

test('a repo with confirmed-absent remote emits dedupVerified: false with remoteReadFailed: false', () => {
  const out = collapseDuplicates([
    { name: 'Y', remote: null, head: 'bbb', lastCommit: 2, remoteReadFailed: false }
  ]);
  expect(out).toHaveLength(1);
  expect(out[0].dedupVerified).toBe(false);
  expect(out[0].remoteReadFailed).toBe(false);
});

test('a repo grouped by remote key emits dedupVerified: true', () => {
  const out = collapseDuplicates([
    { name: 'Real', remote: 'https://github.com/owner/repo.git', head: 'ccc', lastCommit: 5, remoteReadFailed: false }
  ]);
  expect(out).toHaveLength(1);
  expect(out[0].dedupVerified).toBe(true);
  expect(out[0].remoteReadFailed).toBe(false);
});

// --- Fix round 1: composition, not the parts -------------------------------
//
// Every test above hand-constructs records that already carry `head`. That
// masked a real bug: enumerateLocal's real output never carried `head` at
// all (only buildShallowCard ever computed it, downstream and too late), so
// collapseDuplicates's divergence check -- `rest.some(r => r.head !==
// winner.head)` -- compared undefined against undefined in the actual
// enumerateLocal -> collapseDuplicates composition and could never fire.
// "Diverged pairs flag rather than silently pick" was dead in the library
// path despite passing every unit test above. These tests exercise the real
// composition with real git fixtures -- the only way to catch this class of
// defect, and each proves its fixture is genuinely in the state it claims
// before trusting the assertion that depends on it.

function initRepoWithRemote(dir, remoteUrl) {
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "compose@vibe-recall.local"', { cwd: dir });
  execSync('git config user.name "Compose Test"', { cwd: dir });
  execSync('git config core.autocrlf false', { cwd: dir });
  execSync(`git remote add origin ${remoteUrl}`, { cwd: dir });
}

function commitFile(dir, filename, content) {
  fs.writeFileSync(path.join(dir, filename), content);
  execSync('git add -A', { cwd: dir });
  execSync('git commit -q -m commit', { cwd: dir });
}

describe('enumerateLocal -> collapseDuplicates composition (real git fixtures)', () => {
  test('two real clones of one remote with genuinely different heads are flagged diverged, not silently picked', () => {
    const estateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-compose-diverge-'));
    try {
      const remoteUrl = 'https://github.com/e/Composed.git';
      const dirA = path.join(estateRoot, 'ComposedA');
      const dirB = path.join(estateRoot, 'ComposedB');
      initRepoWithRemote(dirA, remoteUrl);
      commitFile(dirA, 'README.md', 'A content\n');
      initRepoWithRemote(dirB, remoteUrl);
      commitFile(dirB, 'README.md', 'B content, deliberately different\n');

      const enumerated = enumerateLocal({ estateRoot, walls: ['Acme'], exclude: [] });
      // Prove head is actually being captured (a real hash, not vacuously
      // absent) before trusting anything downstream of it.
      expect(enumerated.every(r => typeof r.head === 'string' && /^[0-9a-f]{7,40}$/.test(r.head))).toBe(true);
      const headA = enumerated.find(r => r.name === 'ComposedA').head;
      const headB = enumerated.find(r => r.name === 'ComposedB').head;
      // Prove the fixture genuinely diverged before trusting the collapse
      // assertion below -- otherwise a false pass could mean "heads happened
      // to collide," not "divergence detection works."
      expect(headA).not.toBe(headB);

      const collapsed = collapseDuplicates(enumerated);
      expect(collapsed).toHaveLength(1);
      expect(collapsed[0].diverged).toBe(true);
      const names = [collapsed[0].name, ...collapsed[0].siblings].sort();
      expect(names).toEqual(['ComposedA', 'ComposedB']);
    } finally {
      fs.rmSync(estateRoot, { recursive: true, force: true });
    }
  });

  test('two real clones of one remote at the identical head are not flagged diverged, sibling still recorded', () => {
    const estateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-compose-identical-'));
    try {
      const remoteUrl = 'https://github.com/e/Identical.git';
      const dirA = path.join(estateRoot, 'IdenticalA');
      initRepoWithRemote(dirA, remoteUrl);
      commitFile(dirA, 'README.md', 'same content\n');

      const dirB = path.join(estateRoot, 'IdenticalB');
      execSync(`git clone -q "${dirA}" "${dirB}"`, { cwd: estateRoot });
      execSync(`git remote set-url origin ${remoteUrl}`, { cwd: dirB });

      const enumerated = enumerateLocal({ estateRoot, walls: ['Acme'], exclude: [] });
      const headA = enumerated.find(r => r.name === 'IdenticalA').head;
      const headB = enumerated.find(r => r.name === 'IdenticalB').head;
      // Prove the fixture is genuinely identical, and that "identical" means
      // a real shared hash, not both sides silently null.
      expect(headA).toMatch(/^[0-9a-f]{7,40}$/);
      expect(headA).toBe(headB);

      const collapsed = collapseDuplicates(enumerated);
      expect(collapsed).toHaveLength(1);
      expect(collapsed[0].diverged).toBe(false);
      const names = [collapsed[0].name, ...collapsed[0].siblings].sort();
      expect(names).toEqual(['IdenticalA', 'IdenticalB']);
    } finally {
      fs.rmSync(estateRoot, { recursive: true, force: true });
    }
  });

  test('a repo with zero commits yields head: null and lastCommit: null without throwing', () => {
    const estateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-compose-empty-'));
    try {
      const dir = path.join(estateRoot, 'NeverCommitted');
      fs.mkdirSync(dir, { recursive: true });
      execSync('git init -q', { cwd: dir });
      // Deliberately no commit: rev-parse HEAD and log -1 both fail on a
      // repo in this state, which is the case being proven safe.

      let enumerated;
      expect(() => {
        enumerated = enumerateLocal({ estateRoot, walls: ['Acme'], exclude: [] });
      }).not.toThrow();
      const empty = enumerated.find(r => r.name === 'NeverCommitted');
      expect(empty).toBeDefined();
      expect(empty.head).toBeNull();
      expect(empty.lastCommit).toBeNull();
    } finally {
      fs.rmSync(estateRoot, { recursive: true, force: true });
    }
  });

  test('two repos with zero commits sharing a remote do not read as diverged just because both heads are null', () => {
    const estateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-compose-both-empty-'));
    try {
      const remoteUrl = 'https://github.com/e/BothEmpty.git';
      for (const name of ['EmptyA', 'EmptyB']) {
        initRepoWithRemote(path.join(estateRoot, name), remoteUrl);
        // no commit in either -- this is the null !== null trap, inverted
      }

      const enumerated = enumerateLocal({ estateRoot, walls: ['Acme'], exclude: [] });
      // Prove both are genuinely null (the state under test), not just
      // "happens to be falsy" for some other reason.
      expect(enumerated).toHaveLength(2);
      expect(enumerated.every(r => r.head === null)).toBe(true);

      const collapsed = collapseDuplicates(enumerated);
      expect(collapsed).toHaveLength(1);
      expect(collapsed[0].diverged).toBe(false);
      const names = [collapsed[0].name, ...collapsed[0].siblings].sort();
      expect(names).toEqual(['EmptyA', 'EmptyB']);
    } finally {
      fs.rmSync(estateRoot, { recursive: true, force: true });
    }
  });

  // Fix round 2, Finding 3: the four tests above cover null/null (both
  // empty) and hash/hash (both with commits) but not the asymmetric case --
  // one empty clone and one with real commits, sharing a remote. That IS a
  // divergence (a real head differs from a null head, and null !== 'abc123'
  // is true), but it's the one branch of the null-comparison space this
  // whole fix round exists to make trustworthy that had gone unverified.
  test('one empty clone and one with commits, sharing a remote, collapse as diverged with the non-empty repo canonical', () => {
    const estateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-compose-asymmetric-'));
    try {
      const remoteUrl = 'https://github.com/e/Asymmetric.git';
      const emptyDir = path.join(estateRoot, 'AsymmetricEmpty');
      initRepoWithRemote(emptyDir, remoteUrl); // no commit

      const realDir = path.join(estateRoot, 'AsymmetricReal');
      initRepoWithRemote(realDir, remoteUrl);
      commitFile(realDir, 'README.md', 'has real history\n');

      const enumerated = enumerateLocal({ estateRoot, walls: ['Acme'], exclude: [] });
      const emptyRec = enumerated.find(r => r.name === 'AsymmetricEmpty');
      const realRec = enumerated.find(r => r.name === 'AsymmetricReal');
      // Prove the asymmetry is genuinely what it claims -- one null, one a
      // real hash -- before trusting the collapse result below.
      expect(emptyRec.head).toBeNull();
      expect(realRec.head).toMatch(/^[0-9a-f]{7,40}$/);

      const collapsed = collapseDuplicates(enumerated);
      expect(collapsed).toHaveLength(1);
      expect(collapsed[0].diverged).toBe(true);
      // The repo with real commits (a positive lastCommit) sorts ahead of
      // the empty one (lastCommit: null, treated as 0) and wins canonical.
      expect(collapsed[0].name).toBe('AsymmetricReal');
      expect(collapsed[0].siblings).toEqual(['AsymmetricEmpty']);
    } finally {
      fs.rmSync(estateRoot, { recursive: true, force: true });
    }
  });
});
