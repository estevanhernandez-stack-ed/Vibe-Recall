import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Ajv from 'ajv';
import { resolveDataHome } from './datahome.mjs';

// No tenant wall ships pre-seeded: a fresh install has nothing to wall off
// until first-run-setup asks the user to configure one. The floor mechanism
// below (loadConfig unions DEFAULT_WALLS into the effective walls, and a
// default can be added to but never subtracted) is unchanged and would
// protect any future re-seed the same way -- only the seed itself is empty.
export const DEFAULT_WALLS = [];
export const DEFAULT_EXCLUDE = ['_scratch', '_gitnexus-runner'];

// git config falls back to the global/system config when estateRoot isn't
// itself a repo, which is the common case — the estate root is a plain
// directory of repos, not a repo of its own.
function readGitIdentity(estateRoot, key) {
  try {
    const value = execFileSync('git', ['-C', estateRoot, 'config', '--get', key],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return value || null;
  } catch {
    return null;
  }
}

export function detectAuthors(estateRoot) {
  const identity = [readGitIdentity(estateRoot, 'user.name'), readGitIdentity(estateRoot, 'user.email')];
  return identity.filter(Boolean);
}

const schema = JSON.parse(
  fs.readFileSync(new URL('../schemas/config.schema.json', import.meta.url), 'utf8')
);
const validate = new Ajv({ allErrors: true, useDefaults: true }).compile(schema);

export function validateConfig(obj) {
  const clone = JSON.parse(JSON.stringify(obj));
  const valid = validate(clone);
  const errors = (validate.errors || []).map(e => {
    let msg = `${e.instancePath || '/'} ${e.message}`;
    if (e.keyword === 'additionalProperties' && e.params.additionalProperty) {
      msg = `/ ${e.params.additionalProperty} ${e.message}`;
    }
    return msg;
  });
  return {
    valid,
    errors,
    value: clone
  };
}

export function configPath(env = process.env) {
  return path.join(resolveDataHome(env).dir, 'config.json');
}

export function loadConfig(env = process.env) {
  const p = configPath(env);
  if (!fs.existsSync(p)) return null;
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`vibe-recall: malformed JSON in config at ${p}: ${e.message}`);
  }
  const { valid, errors, value } = validateConfig(obj);
  if (!valid) throw new Error(`vibe-recall: invalid config at ${p}: ${errors.join('; ')}`);
  const effectiveValue = { ...value };
  effectiveValue.walls = [...new Set([...DEFAULT_WALLS, ...(value.walls || [])])];
  effectiveValue.authors = (value.authors && value.authors.length > 0)
    ? value.authors
    : detectAuthors(value.estateRoot);
  return effectiveValue;
}
