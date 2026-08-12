import fs from 'node:fs';
import Ajv from 'ajv';
import { enumerateLocal, collapseDuplicates } from '../engine/corpus.mjs';
import { makeEstate, cleanEstate } from './fixture-estate.mjs';

const schema = JSON.parse(
  fs.readFileSync(new URL('../schemas/record.schema.json', import.meta.url), 'utf8')
);
const validate = new Ajv({ allErrors: true }).compile(schema);

test('schema validates a local repo with a remote URL', () => {
  const record = {
    name: 'MyRepo',
    path: '/home/user/MyRepo',
    origin: 'local',
    remote: 'git@github.com:user/MyRepo.git',
    provenance: 'own',
    provenanceKnown: true,
    remoteReadFailed: false
  };
  expect(validate(record)).toBe(true);
});

test('schema validates a local repo with no remote configured (remote=null)', () => {
  const record = {
    name: 'NoRemote',
    path: '/home/user/NoRemote',
    origin: 'local',
    remote: null,
    provenance: 'own',
    provenanceKnown: true,
    remoteReadFailed: false
  };
  expect(validate(record)).toBe(true);
});

test('schema validates a remote-only repo', () => {
  const record = {
    name: 'CloudOnly',
    path: null,
    origin: 'remote',
    remote: 'https://github.com/user/CloudOnly',
    provenance: 'own',
    provenanceKnown: false
  };
  expect(validate(record)).toBe(true);
});

test('schema validates a local foreign repo', () => {
  const record = {
    name: 'ForeignRepo',
    path: '/home/user/ForeignRepo',
    origin: 'local',
    remote: 'git@github.com:upstream/ForeignRepo.git',
    provenance: 'foreign',
    provenanceKnown: true,
    remoteReadFailed: false
  };
  expect(validate(record)).toBe(true);
});

test('schema rejects record missing required field (remote)', () => {
  const record = {
    name: 'MyRepo',
    path: '/home/user/MyRepo',
    origin: 'local',
    provenance: 'own',
    provenanceKnown: true,
    remoteReadFailed: false
  };
  expect(validate(record)).toBe(false);
  expect(validate.errors.some(e => e.keyword === 'required' && e.params.missingProperty === 'remote')).toBe(true);
});

test('schema rejects record with additional properties', () => {
  const record = {
    name: 'MyRepo',
    path: '/home/user/MyRepo',
    origin: 'local',
    remote: 'git@github.com:user/MyRepo.git',
    provenance: 'own',
    provenanceKnown: true,
    remoteReadFailed: false,
    extraField: 'should not exist'
  };
  expect(validate(record)).toBe(false);
  expect(validate.errors.some(e => e.keyword === 'additionalProperties')).toBe(true);
});

test('schema rejects remote with wrong type (number instead of string/null)', () => {
  const record = {
    name: 'MyRepo',
    path: '/home/user/MyRepo',
    origin: 'local',
    remote: 123,
    provenance: 'own',
    provenanceKnown: true,
    remoteReadFailed: false
  };
  expect(validate(record)).toBe(false);
});

test('schema rejects provenance with invalid enum value', () => {
  const record = {
    name: 'MyRepo',
    path: '/home/user/MyRepo',
    origin: 'local',
    remote: 'git@github.com:user/MyRepo.git',
    provenance: 'unknown',
    provenanceKnown: true,
    remoteReadFailed: false
  };
  expect(validate(record)).toBe(false);
  expect(validate.errors.some(e => e.keyword === 'enum')).toBe(true);
});

// --- Fix round 2, Finding 2 -------------------------------------------------
//
// Every test above validates a hand-built object. That's exactly how this
// schema went stale unnoticed: collapseDuplicates adds canonical, siblings,
// diverged and dedupVerified to every record it returns, additionalProperties
// is false, and every hand-built fixture above happens to omit precisely
// those four fields -- so this file could stay green forever no matter how
// far the schema drifted from its real producer's actual output. These tests
// run the real enumerateLocal -> collapseDuplicates pipeline against a real
// git fixture and validate what actually comes out, which is the one check
// that cannot go stale the same way.
describe('the schema validates the real output of its producers, not just hand-built fixtures', () => {
  let estateRoot;

  beforeAll(() => { estateRoot = makeEstate(); });
  afterAll(() => cleanEstate(estateRoot));

  test('a raw enumerateLocal record (pre-dedup) validates', () => {
    const config = { estateRoot, walls: ['Acme'], exclude: [] };
    const records = enumerateLocal(config);
    // Prove the fixture actually produced records before trusting a
    // validation pass over an empty array.
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      const ok = validate(record);
      expect(ok).toBe(true);
    }
  });

  test('a post-collapseDuplicates record validates -- this is the check that would have caught the schema drift', () => {
    const config = { estateRoot, walls: ['Acme'], exclude: [] };
    const collapsed = collapseDuplicates(enumerateLocal(config));
    expect(collapsed.length).toBeGreaterThan(0);
    // Prove the fixture genuinely exercises the four fields under test --
    // not just "some object came back that happens to validate."
    expect(collapsed.every(r => typeof r.canonical === 'boolean')).toBe(true);
    expect(collapsed.every(r => Array.isArray(r.siblings))).toBe(true);
    expect(collapsed.every(r => typeof r.diverged === 'boolean')).toBe(true);
    expect(collapsed.every(r => typeof r.dedupVerified === 'boolean')).toBe(true);
    for (const record of collapsed) {
      const ok = validate(record);
      expect(ok).toBe(true);
    }
  });
});
