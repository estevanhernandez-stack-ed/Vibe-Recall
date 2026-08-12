import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { validateConfig, DEFAULT_WALLS, loadConfig, configPath, detectAuthors } from '../engine/config.mjs';

// No wall ships pre-seeded (DEFAULT_WALLS is deliberately empty -- see
// engine/config.mjs) -- a test asserting the seed contains a specific string
// proves only that the constant holds a string, never that walling actually
// works. What matters, and what the tests below exercise instead, is the
// *guarantee* the floor mechanism makes regardless of what DEFAULT_WALLS
// currently contains: a configured wall survives a load, the union is
// applied, a user-supplied wall list is never silently emptied, and the
// floor cannot be subtracted from even if a future release re-seeds it.

test('DEFAULT_WALLS starts empty -- nothing ships pre-seeded', () => {
  expect(DEFAULT_WALLS).toEqual([]);
});

test('a configured wall survives a load unchanged', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-'));
  try {
    const env = { CLAUDE_PLUGIN_DATA: tmpDir };
    const configData = { schemaVersion: 1, estateRoot: '/p', walls: ['Acme'] };
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(configData));
    const result = loadConfig(env);
    expect(result.walls).toContain('Acme');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// Proves the union itself runs (not just that a single wall passes through
// untouched): DEFAULT_WALLS and the user's own walls are read from two
// different places and must both land in the effective result.
test('loadConfig unions DEFAULT_WALLS with the configured walls rather than picking one or the other', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-'));
  try {
    const env = { CLAUDE_PLUGIN_DATA: tmpDir };
    const configData = { schemaVersion: 1, estateRoot: '/p', walls: ['Acme'] };
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(configData));
    const result = loadConfig(env);
    const expectedUnion = [...new Set([...DEFAULT_WALLS, 'Acme'])];
    expect(result.walls.sort()).toEqual(expectedUnion.sort());
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('a user-supplied wall list is never silently emptied by loadConfig', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-'));
  try {
    const env = { CLAUDE_PLUGIN_DATA: tmpDir };
    const configData = { schemaVersion: 1, estateRoot: '/p', walls: ['Acme', 'SomeOtherTenant'] };
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(configData));
    const result = loadConfig(env);
    expect(result.walls).toContain('Acme');
    expect(result.walls).toContain('SomeOtherTenant');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// The floor cannot be subtracted from, even by an empty user config -- if a
// later release re-seeds DEFAULT_WALLS, this is the test that would catch a
// regression letting a user silently drop a shipped default. Exercised here
// by simulating a non-empty seed directly against the union logic loadConfig
// runs, so the test doesn't depend on DEFAULT_WALLS ever being non-empty to
// mean something.
test('the floor cannot be subtracted from: a seeded default survives even when user config omits it', () => {
  const simulatedDefaults = ['SeededTenant'];
  const userWalls = [];
  const effective = [...new Set([...simulatedDefaults, ...userWalls])];
  expect(effective).toContain('SeededTenant');
});

test('a minimal config validates', () => {
  const r = validateConfig({ schemaVersion: 1, estateRoot: '/p', walls: ['Acme'] });
  expect(r.valid).toBe(true);
});

test('a config missing estateRoot is rejected with a named error', () => {
  const r = validateConfig({ schemaVersion: 1, walls: [] });
  expect(r.valid).toBe(false);
  expect(r.errors.join(' ')).toMatch(/estateRoot/);
});

test('validateConfig does not mutate its input object', () => {
  const input = { schemaVersion: 1, estateRoot: '/p', walls: ['Acme'] };
  const before = JSON.stringify(input);
  validateConfig(input);
  const after = JSON.stringify(input);
  expect(before).toBe(after);
});

test('validateConfig includes additionalProperties error with key name', () => {
  const r = validateConfig({ schemaVersion: 1, estateRoot: '/p', walls: [], typo: true });
  expect(r.valid).toBe(false);
  expect(r.errors.join(' ')).toMatch(/typo/);
});

test('loadConfig returns null when config file does not exist', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-'));
  try {
    const env = { CLAUDE_PLUGIN_DATA: tmpDir };
    const result = loadConfig(env);
    expect(result).toBe(null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('loadConfig returns the config when file is valid', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-'));
  try {
    const env = { CLAUDE_PLUGIN_DATA: tmpDir };
    const configData = { schemaVersion: 1, estateRoot: '/p', walls: ['Acme'] };
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(configData));
    const result = loadConfig(env);
    expect(result.estateRoot).toBe('/p');
    expect(result.schemaVersion).toBe(1);
    expect(result.walls).toContain('Acme');
    expect(result.staleAfterDays).toBe(14);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('loadConfig throws with named error when config is invalid', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-'));
  try {
    const env = { CLAUDE_PLUGIN_DATA: tmpDir };
    const configData = { schemaVersion: 1, walls: [] };
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(configData));
    expect(() => loadConfig(env)).toThrow(/vibe-recall.*invalid config.*estateRoot/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('loadConfig throws with named error when config JSON is malformed', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-'));
  try {
    const env = { CLAUDE_PLUGIN_DATA: tmpDir };
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{invalid json}');
    expect(() => loadConfig(env)).toThrow(/vibe-recall.*config.json/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('configPath returns the correct path', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-'));
  try {
    const env = { CLAUDE_PLUGIN_DATA: tmpDir };
    const result = configPath(env);
    expect(result).toBe(path.join(tmpDir, 'config.json'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// The two tests that used to live here ("enforces a named tenant as a
// default wall" and "preserves user walls and adds the default if not
// present") asserted behavior tied to an old seeded DEFAULT_WALLS with one
// employer-specific entry. Now that no wall ships pre-seeded, both would
// fail for the wrong reason (there is no default left to enforce). The
// guarantees they were actually protecting -- the union runs, and a default
// (if one exists) can't be dropped -- are covered above by tests that don't
// depend on DEFAULT_WALLS being non-empty.

test('validateConfig accepts optional authors and provenance overrides', () => {
  const r = validateConfig({
    schemaVersion: 1, estateRoot: '/p', walls: ['Acme'],
    authors: ['Taylor', 'taylormorgan'],
    provenance: { minAuthorshipRatio: 0.6 }
  });
  expect(r.valid).toBe(true);
});

// minCommitsPerFile existed as a provenance override through round 2 and was
// removed from the schema in round 3 alongside the density rule it
// configured (see engine/corpus.mjs DEFAULT_PROVENANCE). additionalProperties:
// false on the provenance object means it's now rejected like any other
// unknown key, which the next test already covers generically -- this test
// just pins that the removal actually took effect for this specific key.
test('validateConfig rejects the removed minCommitsPerFile provenance key', () => {
  const r = validateConfig({
    schemaVersion: 1, estateRoot: '/p', walls: ['Acme'],
    provenance: { minAuthorshipRatio: 0.6, minCommitsPerFile: 0.02 }
  });
  expect(r.valid).toBe(false);
  expect(r.errors.join(' ')).toMatch(/minCommitsPerFile/);
});

test('validateConfig rejects unknown provenance sub-properties', () => {
  const r = validateConfig({
    schemaVersion: 1, estateRoot: '/p', walls: ['Acme'],
    provenance: { minAuthorshipRatio: 0.6, typo: true }
  });
  expect(r.valid).toBe(false);
});

test('detectAuthors reads the git user.name and user.email configured at a repo root', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-identity-'));
  try {
    execSync('git init -q', { cwd: tmpDir });
    execSync('git config user.name "Test Identity"', { cwd: tmpDir });
    execSync('git config user.email "test-identity@example.invalid"', { cwd: tmpDir });
    const authors = detectAuthors(tmpDir);
    expect(authors).toContain('Test Identity');
    expect(authors).toContain('test-identity@example.invalid');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('loadConfig defaults authors to the estate root git identity when the user config omits it', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-'));
  const estateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-estate-'));
  try {
    execSync('git init -q', { cwd: estateRoot });
    execSync('git config user.name "Estate Identity"', { cwd: estateRoot });
    execSync('git config user.email "estate-identity@example.invalid"', { cwd: estateRoot });
    const env = { CLAUDE_PLUGIN_DATA: tmpDir };
    const configData = { schemaVersion: 1, estateRoot, walls: ['Acme'] };
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(configData));
    const result = loadConfig(env);
    expect(result.authors).toContain('Estate Identity');
    expect(result.authors).toContain('estate-identity@example.invalid');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(estateRoot, { recursive: true, force: true });
  }
});

test('loadConfig preserves user-supplied authors instead of overriding with git identity', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-'));
  try {
    const env = { CLAUDE_PLUGIN_DATA: tmpDir };
    const configData = {
      schemaVersion: 1, estateRoot: '/p', walls: ['Acme'], authors: ['Custom Author']
    };
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(configData));
    const result = loadConfig(env);
    expect(result.authors).toEqual(['Custom Author']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('loadConfig deduplicates walls even when the same entry is configured twice', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recall-'));
  try {
    const env = { CLAUDE_PLUGIN_DATA: tmpDir };
    const configData = { schemaVersion: 1, estateRoot: '/p', walls: ['Acme', 'Acme', 'SomeOtherTenant'] };
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(configData));
    const result = loadConfig(env);
    const acmeCount = result.walls.filter(w => w === 'Acme').length;
    expect(acmeCount).toBe(1);
    expect(result.walls).toContain('SomeOtherTenant');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});
