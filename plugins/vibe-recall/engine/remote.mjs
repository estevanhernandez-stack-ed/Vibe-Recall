import { execFileSync } from 'node:child_process';
import { normalizeRemote, assertNoWalled, isSegmentWalled } from './corpus.mjs';

const ghRunner = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

export function remoteOnly(config, localRepos = [], runner = ghRunner) {
  const accounts = config.githubAccounts || [];
  const walls = config.walls || [];
  if (accounts.length === 0) return [];

  const localKeys = new Set(localRepos.map(r => normalizeRemote(r.remote)).filter(Boolean));
  const out = [];

  for (const account of accounts) {
    // The wall was previously checked only against each repo's own name --
    // the account being enumerated was never compared to the walls at all.
    // A configured GitHub account matching a wall (e.g. an employer org) got
    // fully indexed, name-by-name, with nothing catching it: assertNoWalled
    // below can't help either, since a remote record's path is always null,
    // so only its name branch ever runs. Skip the account outright before
    // ever calling the runner for it.
    if (isSegmentWalled(account, walls)) continue;
    let raw;
    try {
      raw = runner(['repo', 'list', account, '--limit', '500', '--json', 'name,url']);
    } catch {
      return out;
    }
    let list;
    try { list = JSON.parse(raw); } catch { continue; }
    for (const r of list) {
      const key = normalizeRemote(r.url);
      if (!key || localKeys.has(key)) continue;
      // Skip repos whose name matches a wall entry (case-insensitive).
      if (isSegmentWalled(r.name, walls)) continue;
      // Skip repos whose URL owner/org segment matches a wall, independent
      // of the repo's own name -- an innocently named repo living under a
      // walled owner (e.g. github.com/Acme/InnocentName) must be dropped
      // too. key is `${host}/${owner}/...`; the owner segment is always
      // the second element.
      const ownerSegment = key.split('/')[1];
      if (ownerSegment && isSegmentWalled(ownerSegment, walls)) continue;
      out.push({
        name: r.name,
        path: null,
        origin: 'remote',
        remote: r.url,
        // Remote repos cannot be classified from local history.
        // Not-classifiable is not foreign: default to 'own'.
        // provenanceKnown signals we didn't verify this locally.
        provenance: 'own',
        provenanceKnown: false
      });
    }
  }
  assertNoWalled(out, walls);
  return out;
}
