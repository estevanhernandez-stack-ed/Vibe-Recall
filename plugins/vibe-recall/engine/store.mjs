import fs from 'node:fs';
import path from 'node:path';
import { resolveDataHome } from './datahome.mjs';

// resolveDataHome's tier 1 (CLAUDE_PLUGIN_DATA set) hands the directory back
// verbatim, so on Windows it can carry native backslashes; tier 2 (the
// legacy ~/.claude/plugins/data fallback) already normalizes to forward
// slashes -- see datahome.mjs. A plain path.join is separator-aware only for
// the *current* platform: on POSIX a backslash is just another filename
// character, so a tier-1 dir carrying backslashes would join into one
// garbled path segment instead of a nested directory, and the write would
// "succeed" into the wrong place with no error at all. Force forward
// slashes here, unconditionally, before any join, so both tiers land on one
// convention. fs accepts forward slashes on every platform this plugin
// targets, so this normalization is never a regression, only a fix.
function normalizeSeparators(dir) {
  return dir.split(path.win32.sep).join('/');
}

// UNC network paths (\\server\share\... or //server/share/...) are refused
// upstream, in resolveDataHome itself (engine/datahome.mjs) -- not here.
// That function reads CLAUDE_PLUGIN_DATA/HOME/USERPROFILE and does its own
// separator collapsing before this module ever sees `dir`; a check placed
// here could only catch inputs that happen to survive that transformation
// unchanged (true for tier 1, false for tier 2 -- a gap a prior fix round
// left open by checking here instead of there). By the time cardsPath
// receives `dir`, resolveDataHome has already guaranteed it is not
// UNC-shaped, so every caller of this module inherits that guarantee for
// free rather than needing its own copy of the check.
function cardsPath(env) {
  return path.posix.join(normalizeSeparators(resolveDataHome(env).dir), 'cards.json');
}

export function saveCards(cards, env = process.env) {
  const p = cardsPath(env);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ schemaVersion: 1, cards }, null, 2));
  } catch (e) {
    // Matches readCards' convention below: a raw, unlabeled fs error
    // escaping here would be exactly the kind of silent-failure surface
    // this module exists to close off.
    throw new Error(`vibe-recall: could not write cards at ${p}: ${e.message}`);
  }
  return p;
}

export function readCards(env = process.env) {
  const p = cardsPath(env);
  // No file yet is a legitimate, honest "nothing indexed" -- distinct from a
  // file that exists but cannot be read or parsed, which is a real failure
  // and must not collapse into the same silent empty result.
  if (!fs.existsSync(p)) return [];
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error(`vibe-recall: could not read cards at ${p}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`vibe-recall: malformed JSON in cards at ${p}: ${e.message}`);
  }
  return parsed.cards || [];
}

export function bumpHits(names, env = process.env) {
  const cards = readCards(env);
  const set = new Set(names);
  for (const c of cards) if (set.has(c.repo)) c.recallHits = (c.recallHits || 0) + 1;
  saveCards(cards, env);
  return cards;
}
