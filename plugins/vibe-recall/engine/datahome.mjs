import path from 'node:path';

// A UNC network path (\\server\share\... or its less common //server/share/...
// form) cannot survive the forward-slash normalization below: two leading
// separator characters carry the "this is a network root, not a
// filesystem-relative path" meaning, and path.posix.join collapses a doubled
// leading slash down to one. That turns \\server\share\vibe-recall into
// /server/share/vibe-recall, which fs then resolves root-relative to
// whatever drive the process happens to be running from -- a plausible-
// looking local path that is not where the user pointed the environment
// variable, with no error anywhere in the chain.
//
// This check lives here, not in a downstream consumer like store.mjs, and
// applies to every raw input this function reads (CLAUDE_PLUGIN_DATA on
// tier 1, HOME or USERPROFILE on tier 2) *before* any transformation. It has
// to: tier 2's own path.posix.join below already destroys the UNC signal
// before returning `dir`, so a check placed downstream of that join can only
// ever see the collapsed, already-ambiguous result -- exactly the gap a
// prior fix round left open by checking store.mjs's cardsPath instead of
// here. The invariant belongs where the transformation happens, once, so
// every caller (store.mjs, config.mjs, anything future) inherits it for
// free instead of each having to re-apply its own copy.
const UNC_PREFIX = /^[\\/]{2}[^\\/]/;

function refuseIfUnc(value, varName) {
  if (UNC_PREFIX.test(value)) {
    throw new Error(
      `vibe-recall: ${varName} looks like a UNC network path (${value}). ` +
      'Refusing to guess a local-drive location rather than silently writing to ' +
      `the wrong place -- point ${varName} at a local path instead.`
    );
  }
}

export function resolveDataHome(env = process.env) {
  if (env.CLAUDE_PLUGIN_DATA) {
    refuseIfUnc(env.CLAUDE_PLUGIN_DATA, 'CLAUDE_PLUGIN_DATA');
    return { dir: env.CLAUDE_PLUGIN_DATA, tier: 1 };
  }
  const home = env.HOME || env.USERPROFILE;
  if (home) {
    // HOME wins over USERPROFILE when both are set (see the test below) --
    // name whichever one actually supplied the value, so the error tells
    // the user exactly which variable to change rather than a generic
    // "home directory" that could point them at the wrong one.
    const varName = env.HOME ? 'HOME' : 'USERPROFILE';
    refuseIfUnc(home, varName);
    return {
      dir: path.posix.join(home.split(path.win32.sep).join('/'),
        '.claude/plugins/data/vibe-recall'),
      tier: 2
    };
  }
  throw new Error(
    'vibe-recall: no writable data home. Set CLAUDE_PLUGIN_DATA or HOME. ' +
    'Refusing to write silently.'
  );
}
