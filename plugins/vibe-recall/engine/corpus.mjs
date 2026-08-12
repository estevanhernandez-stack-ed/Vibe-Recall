import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MAX_DEPTH = 3;

// Shared logic: check if a segment (or full name/path) matches any wall entry
// using case-insensitive segment-level comparison (not substring matching).
// Segments are the individual components of a path, e.g., "AcmeData" is one
// segment that does not match wall "Acme".
//
// Exported (not just used internally) so remote.mjs can run the exact same
// check against a GitHub account name and a remote URL's owner segment --
// the choke-point this function already is for local paths/names. Before
// this export existed, remote.mjs's own wall check only ever compared
// r.name, never the configured account or the URL's owner segment, and
// assertNoWalled couldn't catch what it missed either: remote records carry
// path: null, so only assertNoWalled's name branch ever ran against them.
export function isSegmentWalled(segment, walls) {
  const segmentLower = segment.toLowerCase();
  return walls.some(w => segmentLower === w.toLowerCase());
}

export function isWalled(absPath, estateRoot, walls) {
  const rel = path.relative(estateRoot, absPath).split(path.sep);
  return rel.some(segment => isSegmentWalled(segment, walls));
}

// Guard: ensure no walled names appear in any record set. Throws if a walled
// name is found, using the same case-insensitive segment-level comparison as isWalled.
// This is the single choke-point that prevents walled repos from surfacing
// regardless of which producer emitted them.
export function assertNoWalled(records, walls) {
  for (const r of records) {
    if (r.name && isSegmentWalled(r.name, walls)) {
      throw new Error(`vibe-recall: walled repo "${r.name}" escaped filtering`);
    }
    if (r.path) {
      // For paths, split on separator and check each segment, same as isWalled.
      const segments = r.path.split(path.sep);
      for (const segment of segments) {
        if (isSegmentWalled(segment, walls)) {
          throw new Error(`vibe-recall: walled path in "${r.path}" escaped filtering`);
        }
      }
    }
  }
}

function readRemote(dir) {
  try {
    const remote = execFileSync('git', ['-C', dir, 'config', '--get', 'remote.origin.url'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    return { remote, remoteReadFailed: false };
  } catch (e) {
    // exit code 1 from `git config --get` means the key is simply unset,
    // which is a legitimate no-remote answer rather than a failure
    const unset = e && e.status === 1;
    return { remote: null, remoteReadFailed: !unset };
  }
}

export function enumerateLocal(config, depth = MAX_DEPTH) {
  const {
    estateRoot, walls = [], exclude = [], authors: configuredAuthors = [], provenance = {}
  } = config;
  const thresholds = { ...DEFAULT_PROVENANCE, ...provenance };
  const found = [];

  // Pass 1: walk the tree, find every local repo, and pull its raw git data
  // (commit count, per-author commit shortlog) exactly once. This raw data
  // feeds both identity discovery and per-repo scoring below, so nothing
  // here re-invokes git a second time for the same repo.
  const walk = (dir, left) => {
    if (left < 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      if (e.name.startsWith('_') || exclude.includes(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (isWalled(abs, estateRoot, walls)) continue;
      if (fs.existsSync(path.join(abs, '.git'))) {
        const { remote, remoteReadFailed } = readRemote(abs);
        found.push({ name: e.name, path: abs, origin: 'local', remote, remoteReadFailed, raw: gitRaw(abs) });
        continue;
      }
      walk(abs, left - 1);
    }
  };

  walk(estateRoot, depth);

  // Pass 2: identity discovery is a whole-corpus operation, computed once
  // per index run over the raw data already gathered above -- not once per
  // repo, and not by shelling out to git again. Discovered identities are
  // unioned with any explicitly configured ones; configuration only adds,
  // it never subtracts a discovered identity (same floor principle as
  // DEFAULT_WALLS). Per-repo scoring below is pure computation from here on.
  const discovered = discoverAuthors(found.map(r => r.raw.shortlog));
  const authors = [...new Set([...discovered, ...configuredAuthors])];

  const result = found.map(({ raw, ...record }) => ({
    ...record,
    // Surfaced from the same gitRaw pass above -- see the comment there for
    // why null (not undefined) is the deliberate empty-repo answer.
    head: raw.head,
    lastCommit: raw.lastCommit,
    provenance: classifyProvenance(statsFromRaw(raw, authors), thresholds),
    // Local records have provenance computed from history and verified locally.
    provenanceKnown: true
  }));
  assertNoWalled(result, walls);
  return result;
}

export function normalizeRemote(url) {
  if (!url) return null;
  let s = String(url).trim()
    .replace(/^git\+/, '')
    .replace(/^ssh:\/\/git@/, '')
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const host = parts[0].toLowerCase();
  const path = parts.slice(1).join('/');
  return `${host}/${path}`;
}

export function collapseDuplicates(repos) {
  const groups = new Map();
  const loners = [];
  for (const r of repos) {
    const key = normalizeRemote(r.remote);
    if (!key) {
      loners.push({
        ...r,
        canonical: true,
        siblings: [],
        diverged: false,
        dedupVerified: false,
        remoteReadFailed: r.remoteReadFailed
      });
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const collapsed = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => (b.lastCommit || 0) - (a.lastCommit || 0));
    const [winner, ...rest] = sorted;
    collapsed.push({
      ...winner,
      canonical: true,
      siblings: rest.map(r => r.name),
      diverged: rest.some(r => r.head !== winner.head),
      dedupVerified: true,
      remoteReadFailed: false
    });
  }
  return [...collapsed, ...loners];
}

// minAuthorshipRatio 0.75: real-estate calibration (--all-scoped, post ref-scope
// fix) put genuine repos at exactly 1.00 (ClipCatcher, mod-launcher, ScanReader)
// against the canonical fork's 0.50 (UtilityFork). 0.5 was tried first
// and failed silently -- it sits exactly on the fork's ratio, and the strict
// "<" comparison let it through. 0.75 gives real margin under 1.00 while
// still clearing 0.50 with room, so authorship catches the fork on its own.
//
// There is deliberately no density/file-count rule here anymore. One
// existed through round 2 (minCommitsPerFile, "foreign if few commits cover
// many files") and was removed in round 3 after a full-estate sweep: it
// fired on 13 of 86 real repos, every one of them a legitimate young repo
// with a large single-commit initial import (a shape indistinguishable by
// file count alone from a vendored dump), and zero of the 13 were a unique
// catch -- every real fork it caught, authorship already caught on its own.
// Zero true positives, thirteen false ones. UtilityFork fires on
// authorship alone (ratio 0.50 against 0.75) with real margin, so removing
// density loses no actual detection.
export const DEFAULT_PROVENANCE = { minAuthorshipRatio: 0.75 };

export function classifyProvenance(stats, t = DEFAULT_PROVENANCE) {
  const {
    totalCommits = 0, ownCommits = 0, authorsConfigured = true, shortlogFailed = false
  } = stats;
  if (totalCommits === 0) return 'own';
  // Fail open: without identities to match against, ownCommits is 0 for every
  // repo and a ratio test would classify the whole estate foreign, returning
  // nothing forever with no error. Not classifiable is not foreign.
  if (!authorsConfigured) return 'own';
  // Fail open, same principle: if the commit count succeeded but the
  // shortlog read itself failed (corrupt refs, a mailmap parse error, odd
  // encoding), ownCommits is 0 not because no configured/discovered author
  // matched, but because we never got real author data at all. That is
  // missing data, not evidence of foreign authorship, and it must not
  // silently read as foreign in the one filter whose whole job is hiding
  // things from the user.
  if (shortlogFailed) return 'own';
  if (ownCommits / totalCommits < t.minAuthorshipRatio) return 'foreign';
  return 'own';
}

// Raw per-repo git data, independent of any author list: total commits and
// the full per-author commit shortlog. Both are scoped to --all (every
// ref), not just HEAD -- a repo with commits on an unmerged branch would
// otherwise produce a numerator (shortlog, already --all) and denominator
// (rev-list) drawn from different populations, letting the authorship ratio
// exceed 1.0. ClipCatcher's feature branch did exactly this before rev-list
// was widened to match.
//
// The two git calls are independent and can fail independently. If
// rev-list succeeds but shortlog throws, shortlogFailed is set so
// classifyProvenance can fail open instead of reading an empty shortlog as
// "zero own commits, therefore foreign."
function gitRaw(dir, run = null) {
  const exec = run || ((args) =>
    execFileSync('git', ['-C', dir, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  let totalCommits = 0;
  const shortlog = [];
  let shortlogFailed = false;
  try { totalCommits = Number(exec(['rev-list', '--count', '--all']).trim()) || 0; } catch {}
  try {
    for (const line of exec(['shortlog', '-sn', '--all']).split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) continue;
      shortlog.push({ name: m[2], count: Number(m[1]) });
    }
  } catch {
    shortlogFailed = true;
  }
  // head/lastCommit: collapseDuplicates needs both, verbatim, to tell a
  // genuine duplicate clone (same head) from a diverged one (different
  // head) -- it cannot do that job with undefined on both sides, which is
  // what every caller got before this. rev-parse HEAD (and log -1) fail on
  // a repo with zero commits -- no branch tip exists yet to resolve -- and
  // that is a legitimate state, not a read error, so it is caught and
  // reported as null rather than thrown or left unset. null is deliberate,
  // not merely "whatever's left after a catch": collapseDuplicates compares
  // with !==, and null !== null is false, so two genuinely empty repos
  // sharing a remote correctly collapse as non-diverged instead of both
  // reading as undefined and looking diverged (or not) by accident.
  //
  // Folded into this same git pass rather than a separate one: enumerateLocal
  // already visits every repo once here (plus once more for its remote URL)
  // -- a repo should not be visited a third and fourth time just to learn
  // what commit it's on.
  let head = null;
  try { head = exec(['rev-parse', '--short', 'HEAD']).trim() || null; } catch {}
  let lastCommit = null;
  try {
    const raw = exec(['log', '-1', '--format=%ct']).trim();
    lastCommit = raw ? Number(raw) : null;
  } catch {}
  return { totalCommits, shortlog, shortlogFailed, head, lastCommit };
}

// Turns raw git data plus a resolved author list into the stats shape
// classifyProvenance consumes. Pure computation, no git calls -- this is
// what lets enumerateLocal score every repo a second time (after identity
// discovery) without re-invoking git.
function statsFromRaw(raw, authors = []) {
  let ownCommits = 0;
  for (const { name, count } of raw.shortlog) {
    if (authors.some(a => name.toLowerCase().includes(a.toLowerCase()))) {
      ownCommits += count;
    }
  }
  return {
    totalCommits: raw.totalCommits,
    ownCommits,
    authorsConfigured: authors.length > 0,
    shortlogFailed: !!raw.shortlogFailed
  };
}

export function repoStats(dir, authors = [], run = null) {
  return statsFromRaw(gitRaw(dir, run), authors);
}

// A developer's git identity varies by machine and by repo config -- this
// user alone commits under at least three forms across the estate. Rather
// than trust a hardcoded/configured author list to be complete, discover
// identities from the corpus itself: an identity that authors commits in
// more than one distinct repo in someone's estate is that person (or a tool
// they use across their own repos); an upstream author absorbed via a fork
// appears in exactly the one repo it was forked from.
//
// The discriminator is simply "appears in more than one repo." A scaling
// formula (max(2, ceil(repoCount * 0.05)), round 2) was tried first and
// proven wrong by a full-estate sweep in round 3: at that formula's
// 5-repo threshold for this ~86-repo estate, a legitimate rare alt
// identity (4 repos) stayed undiscovered and its repos misclassified
// foreign, while both real foreign/outsider authors found in the sweep
// sat at exactly 1 repo each. A flat floor of 2 separates them with no
// ambiguity: nobody who repeats even once across an estate is an upstream
// fork author, and nobody who never repeats is presumptively the owner.
// Kept as a function (not a bare constant) so a future estate could
// recalibrate it, but the calibrated answer is currently flat.
export function minEstateRepos(repoCount) {
  return 2;
}

// Keyed lowercase, deliberately: a developer's git identity varies by
// machine/config, and casing is exactly the kind of variance that varies
// with it (this estate's owner alone commits under five identities).
// statsFromRaw already matches discovered/configured authors case-
// insensitively (`name.toLowerCase().includes(a.toLowerCase())`), but
// discoverAuthors itself used to key by the exact string -- "Taylor
// Morgan" on one repo and "taylor morgan" on another never
// accumulated past 1 each, so neither spelling ever cleared
// minEstateRepos(2), and both repos silently classified foreign. Lowercasing
// here means two case-variant spellings of one person now count as the same
// identity for the threshold check; statsFromRaw's own lowercase comparison
// makes returning the identity lowercase harmless for matching either way.
export function discoverAuthors(shortlogsByRepo) {
  const threshold = minEstateRepos(shortlogsByRepo.length);
  const repoCountByIdentity = new Map();
  for (const shortlog of shortlogsByRepo) {
    const namesInRepo = new Set((shortlog || []).map(s => s.name.toLowerCase()));
    for (const name of namesInRepo) {
      repoCountByIdentity.set(name, (repoCountByIdentity.get(name) || 0) + 1);
    }
  }
  const discovered = [];
  for (const [name, repoCount] of repoCountByIdentity) {
    if (repoCount >= threshold) discovered.push(name);
  }
  return discovered;
}
