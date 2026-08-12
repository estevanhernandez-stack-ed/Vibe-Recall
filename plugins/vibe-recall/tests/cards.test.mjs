import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import Ajv from 'ajv';
import { makeEstate, cleanEstate, RICH_SPEC } from './fixture-estate.mjs';
import { buildShallowCard, looksSecret } from '../engine/cards.mjs';

const cardSchema = JSON.parse(
  fs.readFileSync(new URL('../schemas/card.schema.json', import.meta.url), 'utf8')
);
const validateCard = new Ajv({ allErrors: true }).compile(cardSchema);

let estateRoot;
beforeAll(() => { estateRoot = makeEstate(RICH_SPEC); });
afterAll(() => cleanEstate(estateRoot));

const repo = () => ({
  name: 'GoodApp',
  path: path.join(estateRoot, 'GoodApp'),
  origin: 'local',
  remote: null, canonical: true, siblings: [], diverged: false,
  provenance: 'own', provenanceKnown: true, dedupVerified: true
});

test('card carries stack, deps, symbols and claims', () => {
  const c = buildShallowCard(repo());
  expect(c.depth).toBe('shallow');
  expect(c.deps).toEqual(expect.arrayContaining(['next', 'stripe']));
  expect(c.symbols).toEqual(expect.arrayContaining(['createCheckoutSession']));
  expect(c.claims.join(' ').toLowerCase()).toMatch(/stripe checkout/);
  expect(c.head).toMatch(/^[0-9a-f]{7,40}$/);
});

test('card carries provenance and dedup verification through from the corpus record', () => {
  const c = buildShallowCard(repo());
  expect(c.provenance).toBe('own');
  expect(c.provenanceKnown).toBe(true);
  expect(c.dedupVerified).toBe(true);
});

test('no secret value ever reaches the card', () => {
  const serialized = JSON.stringify(buildShallowCard(repo()));
  // matches the assembled fixture credential from fixture-estate.mjs, never written literally
  expect(serialized).not.toMatch(new RegExp(['sk', 'live'].join('_')));
  expect(serialized).not.toMatch(/STRIPE_SECRET_KEY/);
  expect(serialized).not.toMatch(/a{20,}/);
});

test('no file bodies reach the card', () => {
  const c = buildShallowCard(repo());
  expect(JSON.stringify(c)).not.toMatch(/export function/);
});

test('the .env file itself is skipped rather than partially scanned', () => {
  const c = buildShallowCard(repo());
  expect(c.skippedSecretFiles).toBeGreaterThan(0);
});

test('path separators are normalized to forward slashes on the card', () => {
  const c = buildShallowCard(repo());
  expect(c.path).not.toMatch(/\\/);
  expect(c.path.endsWith('/GoodApp')).toBe(true);
});

test('a remote-only repo (no local path) produces a card without crashing', () => {
  const c = buildShallowCard({
    name: 'CloudOnly', path: null, origin: 'remote', remote: 'https://github.com/e/CloudOnly',
    provenance: 'own', provenanceKnown: false
  });
  expect(c.repo).toBe('CloudOnly');
  expect(c.path).toBeNull();
  expect(c.head).toBeNull();
  expect(c.deps).toEqual([]);
  expect(c.symbols).toEqual([]);
});

test('a real built local card validates against card.schema.json', () => {
  const c = buildShallowCard(repo());
  const ok = validateCard(c);
  expect(validateCard.errors).toBeNull();
  expect(ok).toBe(true);
});

test('a real built remote-only card validates against card.schema.json', () => {
  const c = buildShallowCard({
    name: 'CloudOnly', path: null, origin: 'remote', remote: 'https://github.com/e/CloudOnly',
    provenance: 'own', provenanceKnown: false
  });
  const ok = validateCard(c);
  expect(validateCard.errors).toBeNull();
  expect(ok).toBe(true);
});

test('the schema actually rejects a malformed card (proves the check has teeth)', () => {
  const c = buildShallowCard(repo());
  delete c.depth;
  expect(validateCard(c)).toBe(false);
  expect(validateCard.errors.some(e => e.keyword === 'required' && e.params.missingProperty === 'depth')).toBe(true);
});

// Assembled, never literal: a literal key shape in a tracked file trips
// push protection and every other scanner, as it should.
const fakeStripe = ['sk', 'live', 'a'.repeat(26)].join('_');
const fakeGithubPat = ['ghp', 'b'.repeat(36)].join('_');

test('a source file with a credential anywhere in it is skipped whole, not partially scanned', () => {
  // Isolated scratch dir, deliberately not part of RICH_SPEC/the shared estate:
  // proves whole-file skip in general, not just for the fixture's .env case.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'card-leaky-'));
  try {
    fs.writeFileSync(
      path.join(scratch, 'leaky.ts'),
      [
        'export function definitelyPresent() { return 1; }',
        `const token = "${fakeGithubPat}";`,
        'export function shouldAlsoBeHidden() { return 2; }'
      ].join('\n')
    );
    fs.writeFileSync(path.join(scratch, 'clean.ts'), 'export function cleanSymbol() { return 3; }\n');

    const c = buildShallowCard({ name: 'Leaky', path: scratch, origin: 'local', remote: null });

    // Prove the assertion below isn't vacuous: scanning does find symbols in general.
    expect(c.symbols).toContain('cleanSymbol');
    // The credential-bearing file contributes nothing -- not even its other,
    // unrelated exported functions.
    expect(c.symbols).not.toContain('definitelyPresent');
    expect(c.symbols).not.toContain('shouldAlsoBeHidden');
    expect(c.skippedSecretFiles).toBeGreaterThan(0);
    expect(JSON.stringify(c)).not.toMatch(new RegExp(['ghp', 'b{20,}'].join('_')));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('looksSecret catches common credential shapes', () => {
  expect(looksSecret(`STRIPE_SECRET_KEY=${fakeStripe}`)).toBe(true);
  expect(looksSecret(`token: "${fakeGithubPat}"`)).toBe(true);
  expect(looksSecret('const name = "checkout"')).toBe(false);
  expect(looksSecret('// see docs for how to set STRIPE_SECRET_KEY')).toBe(false);
});

// --- Fix round 1: word-boundary regression -------------------------------
// Assembled, never literal: a live sweep of real .env files found looksSecret
// caught 1 of 34 real credential lines. The cause was \b requiring the
// keyword to START the identifier; real env vars are namespaced
// (VITE_FIREBASE_API_KEY), so the keyword almost always sits mid-identifier.
const namespacedFirebaseKey = ['VITE_FIREBASE_API_KEY=', 'F'.repeat(39)].join('');
const namespacedGeminiKey = ['VITE_GEMINI_API_KEY=', 'G'.repeat(39)].join('');
const namespacedJwtSecret = ['JWT_SECRET_KEY=', 'J'.repeat(34)].join('');
const bareApiKey = ['API_KEY=', 'K'.repeat(20)].join('');

test('looksSecret catches namespaced env-style identifiers (word-boundary fix)', () => {
  expect(looksSecret(namespacedFirebaseKey)).toBe(true);
  expect(looksSecret(namespacedGeminiKey)).toBe(true);
  expect(looksSecret(namespacedJwtSecret)).toBe(true);
  expect(looksSecret(bareApiKey)).toBe(true);
});

const googleApiKeyValue = ['AIza', 'H'.repeat(35)].join('');
test('looksSecret catches Google/Firebase AIza-prefixed keys by value shape alone', () => {
  expect(looksSecret(`VITE_GOOGLE_MAPS_API_KEY=${googleApiKeyValue}`)).toBe(true);
  // Value shape alone (AIza + 35 chars) is enough, independent of key name.
  expect(looksSecret(`randomFieldName: "${googleApiKeyValue}"`)).toBe(true);
});

test('looksSecret does not flag plain URL/hostname env assignments', () => {
  expect(looksSecret('OLLAMA_HOST=http://localhost:11434')).toBe(false);
  expect(looksSecret('ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com')).toBe(false);
  expect(looksSecret('VITE_FIREBASE_AUTH_DOMAIN=my-app.firebaseapp.com')).toBe(false);
  expect(looksSecret('ENTRA_REDIRECT_URI=https://myapp.com/auth/callback')).toBe(false);
});

const dbPasswordSegment = ['p', 'W'.repeat(15)].join('');
const connStringWithCreds = `DATABASE_URL=postgres://dbuser:${dbPasswordSegment}@db.example.com:5432/mydb`;
const connStringNoCreds = 'DATABASE_URL=postgres://db.example.com:5432/mydb';

test('looksSecret catches a connection string with embedded credentials, leaves a bare one alone', () => {
  expect(looksSecret(connStringWithCreds)).toBe(true);
  expect(looksSecret(connStringNoCreds)).toBe(false);
});

test('looksSecret does not flag a legitimate identifier that merely contains a keyword substring', () => {
  const longDescriptor = 'some-descriptive-non-secret-configuration-string-value';
  expect(looksSecret(`myTokenizer = "${longDescriptor}"`)).toBe(false);
  expect(looksSecret(`secretary = "${longDescriptor}"`)).toBe(false);
});

// --- Fix round 2, Finding 1: plural word-boundary regression --------------
// The (?![a-z]) mid-word guard added in round 1 correctly rejects `tokenizer`/
// `secretary`, but a bare guard with no plural allowance also rejects
// `credentials`/`secrets`/`tokens`/`apiKeys` -- the *more* common naming form
// in JS/TS/YAML config, since a trailing lowercase `s` is itself a lowercase
// letter and tripped the same lookahead. Reproduced live via a second sweep
// after the round-1 pattern shipped without a plural test.
const pluralFixtureValue = 'some-descriptive-non-secret-configuration-string-value';

test('looksSecret catches keyword plurals (credentials/secrets/tokens/apiKeys)', () => {
  expect(looksSecret(`credentials: "${pluralFixtureValue}"`)).toBe(true);
  expect(looksSecret(`secrets: "${pluralFixtureValue}"`)).toBe(true);
  expect(looksSecret(`tokens: "${pluralFixtureValue}"`)).toBe(true);
  expect(looksSecret(`apiKeys: "${pluralFixtureValue}"`)).toBe(true);
});

test('looksSecret still rejects a keyword mid-word after the plural fix (precision holds)', () => {
  expect(looksSecret(`tokenizer: "${pluralFixtureValue}"`)).toBe(false);
  expect(looksSecret(`secretary: "${pluralFixtureValue}"`)).toBe(false);
});

// --- Fix round 2, Finding 2: silent cap truncation -------------------------
// caps override lets these trip deterministically against a 2-3 file
// fixture instead of needing a real 512KB file or 5000 real files on disk.
test('a file-count cap trip is recorded on the card, not silently absorbed', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'card-trunc-count-'));
  try {
    fs.writeFileSync(path.join(scratch, 'a.ts'), 'export function fnA() { return 1; }\n');
    fs.writeFileSync(path.join(scratch, 'b.ts'), 'export function fnB() { return 2; }\n');
    fs.writeFileSync(path.join(scratch, '.env'), 'STRIPE_SECRET_KEY=irrelevant-here\n');

    const c = buildShallowCard(
      { name: 'Truncated', path: scratch, origin: 'local', remote: null },
      new Date(),
      { maxFilesRead: 1 }
    );

    expect(c.scanTruncated).toBe(true);
    expect(c.truncatedBy).toContain('maxFilesRead');
    // Exactly one of the two code files got its body read before the cap
    // tripped -- prove the truncation actually happened, not just the flag.
    expect(c.symbols.length).toBe(1);
    // The .env skip needs no file read (name-only check) -- it stays
    // accurate even after the read cap trips, which is the specific defect
    // the early `return` used to cause.
    expect(c.skippedByFilename).toBeGreaterThan(0);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('an oversized-file cap trip is recorded on the card too', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'card-trunc-size-'));
  try {
    fs.writeFileSync(path.join(scratch, 'big.ts'), 'export function bigFn() { return 1; }\n');

    const c = buildShallowCard(
      { name: 'TooBig', path: scratch, origin: 'local', remote: null },
      new Date(),
      { maxFileBytes: 4 } // smaller than the fixture file itself
    );

    expect(c.scanTruncated).toBe(true);
    expect(c.truncatedBy).toContain('maxFileBytes');
    expect(c.symbols).not.toContain('bigFn');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// --- Finding 4 (final whole-branch review): MAX_SYMBOLS truncates silently
// scanCode's own comment (cards.mjs:209-212) already admitted the gap:
// `symbols: [...symbols].slice(0, MAX_SYMBOLS)` cut the set down with no
// honesty signal at all -- measured live against the real estate,
// MarketScanApp and Atlas both reported scanTruncated: false while
// actually carrying ~43% of their real symbol count. This trips the real
// production MAX_SYMBOLS=6000 cap (no caps override exists for it) with a
// small, deterministic fixture: one file, 6005 distinct exported names.
test('a symbol-count cap trip (more real symbols than MAX_SYMBOLS) is recorded on the card, not silently absorbed', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'card-trunc-symbols-'));
  try {
    const lines = [];
    for (let i = 0; i < 6005; i++) lines.push(`export function fn${i}() { return ${i}; }`);
    fs.writeFileSync(path.join(scratch, 'many.ts'), lines.join('\n'));

    const c = buildShallowCard({ name: 'TooManySymbols', path: scratch, origin: 'local', remote: null });

    // Prove the cap actually tripped (more real symbols existed than made
    // it onto the card) before trusting the honesty-signal assertions.
    expect(c.symbols.length).toBe(6000);
    expect(c.scanTruncated).toBe(true);
    expect(c.truncatedBy).toContain('maxSymbols');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('staying under MAX_SYMBOLS does not falsely claim a symbol-count truncation', () => {
  const c = buildShallowCard(repo());
  expect(c.symbols.length).toBeLessThan(6000);
  expect(c.truncatedBy).not.toContain('maxSymbols');
});

test('a card carrying the new maxSymbols truncation reason still validates against card.schema.json', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'card-trunc-symbols-schema-'));
  try {
    const lines = [];
    for (let i = 0; i < 6005; i++) lines.push(`export function fn${i}() { return ${i}; }`);
    fs.writeFileSync(path.join(scratch, 'many.ts'), lines.join('\n'));
    const c = buildShallowCard({ name: 'TooManySymbolsSchema', path: scratch, origin: 'local', remote: null });
    expect(c.truncatedBy).toContain('maxSymbols'); // prove non-vacuous before validating
    const ok = validateCard(c);
    expect(validateCard.errors).toBeNull();
    expect(ok).toBe(true);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// --- Finding 4, folded-in deferred item: cards.mjs's own oversized-README/
// CLAUDE.md size guard (readClaims/readGotchas) returned [] on trip --
// indistinguishable from "this repo genuinely has no README/CLAUDE.md."
// Give it the same scanTruncated/truncatedBy honesty signal the code-scan
// path already has, reusing maxFileBytes since it is the identical guard
// value applied to a different file.
test('an oversized README.md size-guard trip also sets scanTruncated/truncatedBy, not just an empty claims list', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'card-readme-trunc-'));
  try {
    fs.writeFileSync(path.join(scratch, 'README.md'), '# Title\nThis product claims something notable.\n');
    const c = buildShallowCard(
      { name: 'ReadmeTooBigTrunc', path: scratch, origin: 'local', remote: null }, new Date(), { maxFileBytes: 4 }
    );
    // Prove the guard genuinely tripped (claims came back empty despite a
    // real claim line existing in the fixture) before trusting the honesty
    // signal assertions below.
    expect(c.claims).toEqual([]);
    expect(c.scanTruncated).toBe(true);
    expect(c.truncatedBy).toContain('maxFileBytes');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('an oversized CLAUDE.md size-guard trip also sets scanTruncated/truncatedBy, not just an empty gotchas list', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'card-claudemd-trunc-'));
  try {
    fs.writeFileSync(path.join(scratch, 'CLAUDE.md'), '- **A real gotcha worth noting.**\n');
    const c = buildShallowCard(
      { name: 'ClaudeMdTooBigTrunc', path: scratch, origin: 'local', remote: null }, new Date(), { maxFileBytes: 4 }
    );
    expect(c.gotchas).toEqual([]);
    expect(c.scanTruncated).toBe(true);
    expect(c.truncatedBy).toContain('maxFileBytes');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('an untruncated scan reports scanTruncated: false, not vacuously true', () => {
  const c = buildShallowCard(repo());
  expect(c.scanTruncated).toBe(false);
  expect(c.truncatedBy).toEqual([]);
});

// --- Fix round 2, Minor: README.md/CLAUDE.md get the same size guard -------
test('an oversized README.md is skipped rather than read whole (same guard as the code walk)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'card-readme-cap-'));
  try {
    fs.writeFileSync(path.join(scratch, 'README.md'), '# Title\nThis product claims something notable.\n');

    const underCap = buildShallowCard(
      { name: 'ReadmeOk', path: scratch, origin: 'local', remote: null }, new Date(), { maxFileBytes: 1000 }
    );
    expect(underCap.claims.join(' ')).toMatch(/claims something notable/);

    const overCap = buildShallowCard(
      { name: 'ReadmeTooBig', path: scratch, origin: 'local', remote: null }, new Date(), { maxFileBytes: 4 }
    );
    expect(overCap.claims).toEqual([]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// --- Fix round 2, Finding 3: schema must require the carried-through fields
test('the schema requires provenance, provenanceKnown, dedupVerified and scanTruncated individually', () => {
  for (const field of ['provenance', 'provenanceKnown', 'dedupVerified', 'scanTruncated']) {
    const c = buildShallowCard(repo());
    delete c[field];
    expect(validateCard(c)).toBe(false);
    expect(
      validateCard.errors.some(e => e.keyword === 'required' && e.params.missingProperty === field)
    ).toBe(true);
  }
});

// --- Task 9 fix round 2, Minor 1: reuse a precomputed head/lastCommit -----
// enumerateLocal now computes head/lastCommit as part of its own git pass
// (Task 9 fix round 1) and passes both through on every collapsed record.
// buildShallowCard should use that pair when a caller supplies it, instead
// of re-shelling to git for data already in hand.
test('buildShallowCard reuses a precomputed head/lastCommit pair instead of re-shelling to git', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'card-precomputed-head-'));
  try {
    execSync('git init -q', { cwd: scratch });
    execSync('git config user.email "test@vibe-recall.local"', { cwd: scratch });
    execSync('git config user.name "Fixture Test"', { cwd: scratch });
    execSync('git commit -q --allow-empty -m init', { cwd: scratch });

    const c = buildShallowCard({
      name: 'Precomputed', path: scratch, origin: 'local', remote: null,
      head: 'deadbeef', lastCommit: 123456789
    });
    // If buildShallowCard had re-shelled instead of reusing the precomputed
    // pair, it would report the scratch repo's real head (a genuine short
    // hex SHA) and a real recent timestamp, not these fabricated values --
    // so a match here proves the precomputed pair actually took priority
    // over a fresh git call, not just that git happened to agree with it.
    expect(c.head).toBe('deadbeef');
    expect(c.lastCommit).toBe(123456789);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('buildShallowCard reuses a precomputed null head/lastCommit (a zero-commit repo) rather than treating null as "not supplied"', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'card-precomputed-null-head-'));
  try {
    // A real repo WITH commits, so a fallback git call (if the null check
    // were wrong) would return a real, non-null head -- proving the
    // assertion below distinguishes "reused null" from "recompute happened
    // to also return null."
    execSync('git init -q', { cwd: scratch });
    execSync('git config user.email "test@vibe-recall.local"', { cwd: scratch });
    execSync('git config user.name "Fixture Test"', { cwd: scratch });
    execSync('git commit -q --allow-empty -m init', { cwd: scratch });

    const c = buildShallowCard({
      name: 'PrecomputedEmpty', path: scratch, origin: 'local', remote: null,
      head: null, lastCommit: null
    });
    expect(c.head).toBeNull();
    expect(c.lastCommit).toBeNull();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('buildShallowCard still computes head/lastCommit itself when the caller does not supply them (back-compat)', () => {
  // repo() never sets head/lastCommit -- this is every pre-existing test's
  // fixture shape, pinned explicitly so a future change can't silently
  // break the fallback path the rest of this file depends on.
  const c = buildShallowCard(repo());
  expect(c.head).toMatch(/^[0-9a-f]{7,40}$/);
  expect(typeof c.lastCommit).toBe('number');
});

// --- Task 12 coordinator fix round 1: symbol extraction was blind to most
// of the estate --------------------------------------------------------
// The original SYMBOL_RE recognized exactly two shapes (JS/TS `export
// function`, Python `def`). CODE_EXT already listed `.cs` and `.go` before
// this fix -- the miss was never file access, it was that nothing here
// could recognize what those languages' declarations look like. 23 of 83
// real estate cards came back with zero symbols for this reason, which is
// close to unreachable under a ranking that puts symbols above prose. These
// fixtures are small stand-ins for the real per-language shapes the estate
// contains (calibrated against the real files the cowpath notes cite:
// ScanReader's CaptureEngine.cs P/Invoke block, ClipTool's ClipboardWriter.h/
// .cpp), not the real files themselves, so this suite doesn't depend on any
// particular repo existing on disk.
test('symbol extraction recognizes export const, export class, and a plain function declaration (JS/TS)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'card-symbols-js-'));
  try {
    fs.writeFileSync(path.join(scratch, 'a.ts'), [
      'export const createSession = (id) => id;',
      'export class SessionService {}',
      'function helper() { return 1; }'
    ].join('\n'));
    const c = buildShallowCard({ name: 'JsShapes', path: scratch, origin: 'local', remote: null });
    expect(c.symbols).toEqual(expect.arrayContaining(['createSession', 'SessionService', 'helper']));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('symbol extraction recognizes Python class and Go func declarations', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'card-symbols-pygo-'));
  try {
    fs.writeFileSync(path.join(scratch, 'a.py'), 'class Widget:\n    def render(self):\n        pass\n');
    fs.writeFileSync(path.join(scratch, 'b.go'), 'package main\n\nfunc ComputeTotal(x int) int {\n\treturn x\n}\n');
    const c = buildShallowCard({ name: 'PyGoShapes', path: scratch, origin: 'local', remote: null });
    expect(c.symbols).toEqual(expect.arrayContaining(['Widget', 'render', 'ComputeTotal']));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('symbol extraction recognizes C-family declarations, including a same-line attribute prefix (the P/Invoke shape that hid a real repo\'s symbols)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'card-symbols-cfamily-'));
  try {
    fs.writeFileSync(path.join(scratch, 'a.cs'), [
      'public class Widget',
      '{',
      '    [DllImport("user32.dll")] private static extern IntPtr GetHandle(IntPtr hwnd);',
      '',
      '    public Bitmap Render(Rect region)',
      '    {',
      '        return null;',
      '    }',
      '}'
    ].join('\n'));
    fs.writeFileSync(path.join(scratch, 'b.cpp'), [
      'struct DecodedFrame',
      '{',
      '    int width;',
      '};',
      '',
      'bool Widget::SetClipboardFromPng(const std::vector<std::byte>& bytes) noexcept',
      '{',
      '    return true;',
      '}'
    ].join('\n'));
    const c = buildShallowCard({ name: 'CFamilyShapes', path: scratch, origin: 'local', remote: null });
    expect(c.symbols).toEqual(expect.arrayContaining(
      ['Widget', 'GetHandle', 'Render', 'DecodedFrame', 'SetClipboardFromPng']
    ));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('a bare call site is never captured as a declaration -- with or without a control-flow keyword directly in front of it', () => {
  // Regression guard: "else GlobalFree(hDibV5);" (found live in
  // ClipboardWriter.cpp) has the identical "word, space, identifier, ("
  // shape as "private static extern IntPtr GetDC(...)" -- a control-flow
  // keyword reads exactly like a type or modifier to a pattern that only
  // looks at shape. The fix is a keyword stoplist checked before the
  // C-family method alternative can fire at all.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'card-symbols-nofalsepos-'));
  try {
    fs.writeFileSync(path.join(scratch, 'a.cpp'), [
      'void Run()',
      '{',
      '    DoSomething(1, 2);',
      '    if (ready) StartUp();',
      '    else ShutDown();',
      '}'
    ].join('\n'));
    const c = buildShallowCard({ name: 'NoFalsePos', path: scratch, origin: 'local', remote: null });
    // Proves the assertions below aren't vacuous: a real declaration on the
    // same file still gets through.
    expect(c.symbols).toContain('Run');
    expect(c.symbols).not.toContain('DoSomething');
    expect(c.symbols).not.toContain('StartUp');
    expect(c.symbols).not.toContain('ShutDown');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('symbol extraction recognizes Lua local functions and dot/colon-scoped table methods, not truncated by an earlier alternative', () => {
  // Regression guard: `.lua` was added past the coordinator's named floor
  // list after verification turned up a real repo, a genuine 29-file Lua
  // project, still coming back zero-symbol. The first attempt at the Lua
  // pattern was itself shadowed by an ordering bug -- `phpFunction` (and
  // originally `jsPlainFn`) matched the bare word `function` with no
  // trailing `(` requirement, so on a dotted name like `function
  // EvolutionManager.GetEvolutionCost(...)` it won first (list position, not
  // best match) and captured only the truncated `EvolutionManager`. Every
  // bare-word alternative sharing the literal keywords `function`/`fn`/`func`
  // now requires the trailing `(` for exactly this reason.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'card-symbols-lua-'));
  try {
    fs.writeFileSync(path.join(scratch, 'a.lua'), [
      'local function renderMagneticField(starData, starPart)',
      '    return true',
      'end',
      '',
      'function EvolutionManager.GetEvolutionCost(planetData)',
      '    return 1',
      'end',
      '',
      'function TagService:untag(instance, tagName)',
      '    return nil',
      'end'
    ].join('\n'));
    const c = buildShallowCard({ name: 'LuaShapes', path: scratch, origin: 'local', remote: null });
    expect(c.symbols).toEqual(expect.arrayContaining([
      'renderMagneticField', 'EvolutionManager.GetEvolutionCost', 'TagService:untag'
    ]));
    // The bug's own symptom: the truncated table name alone must not be
    // what got captured instead of the fuller, more useful dotted name.
    expect(c.symbols).not.toContain('EvolutionManager');
    expect(c.symbols).not.toContain('TagService');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
