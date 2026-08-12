import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

function initGitRepo(repoPath) {
  execSync('git init -q', { cwd: repoPath });
  execSync('git config user.email "test@vibe-recall.local"', { cwd: repoPath });
  execSync('git config user.name "Fixture Test"', { cwd: repoPath });
  execSync('git commit -q --allow-empty -m init', { cwd: repoPath });
}

function writeFiles(repoPath, fileMap) {
  if (!fileMap) return;
  for (const [filePath, content] of Object.entries(fileMap)) {
    const fullPath = path.join(repoPath, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

// Assembled, never literal: a literal sk_live_<26 chars> in a tracked file
// trips GitHub push protection and every other scanner, because a scanner
// cannot distinguish a plausible fake from a live key, and should not try.
const FAKE_STRIPE = ['sk', 'live', 'a'.repeat(26)].join('_');

// Richer per-repo spec for card-indexing tests (Task 7+): a real package.json
// with deps, a README with a claim line, a source file with an exported
// symbol, and a .env with a fake-but-shaped secret that must never reach a
// card. Exported here (not duplicated per test file) so later tasks share
// the same estate rather than drifting copies of it.
export const RICH_SPEC = {
  'GoodApp': {
    'package.json': JSON.stringify(
      { name: 'goodapp', dependencies: { next: '^15.0.0', stripe: '^14.0.0' } }),
    'README.md': '# GoodApp\nStripe checkout and magic-link auth for the storefront.\n',
    'src/lib/checkout.ts':
      'export function createCheckoutSession(items, uid) { return { url: "", id: "" }; }\n',
    '.env': `STRIPE_SECRET_KEY=${FAKE_STRIPE}\n`
  },
  'OtherApp': {},
  'Acme/SecretWork': { 'README.md': 'walled\n' },
  '_scratch/Junk': {}
};

// spec: optional map of repoName -> { relativeFilePath: content }, for the
// default repos (GoodApp, OtherApp, _scratch/Junk, Acme/SecretWork). Files
// are written into the working tree after the init commit -- never
// committed, matching every other fixture repo here (see below for why
// committed fixture repos silently disabled the wall test).
export function makeEstate(spec = {}) {
  const estateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-estate-'));
  const repos = ['GoodApp', 'OtherApp', '_scratch/Junk'];

  // Create regular repos
  for (const repoName of repos) {
    const repoPath = path.join(estateRoot, repoName);
    fs.mkdirSync(repoPath, { recursive: true });
    initGitRepo(repoPath);
    writeFiles(repoPath, spec[repoName]);
  }

  // Create walled repo at depth
  const secretPath = path.join(estateRoot, 'Acme', 'SecretWork');
  fs.mkdirSync(secretPath, { recursive: true });
  initGitRepo(secretPath);
  fs.writeFileSync(path.join(secretPath, 'README.md'), 'walled');
  writeFiles(secretPath, spec['Acme/SecretWork']);

  return estateRoot;
}

export function cleanEstate(estateRoot) {
  if (estateRoot && fs.existsSync(estateRoot)) {
    fs.rmSync(estateRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
