import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const SECRET_PATTERNS = [
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // Google / Firebase API keys: always AIza + 35 base64url characters, 39 total.
  /\bAIza[0-9A-Za-z\-_]{35}\b/,
  // Connection strings with embedded userinfo credentials (DATABASE_URL,
  // MONGODB_URI, REDIS_URL, ...). Keyed off the *value* shape --
  // scheme://user:password@host -- not the variable name: a DATABASE_URL
  // pointing at a passwordless local db must not flag, and this catches a
  // real embedded credential no matter what the variable happens to be
  // called. 8-char floor on the password segment: short enough to not miss
  // real generated passwords, long enough to leave a bare `user@host` (no
  // password at all) alone.
  /\b\w+:\/\/[^\s:/@]+:[^\s@/]{8,}@/,
  // Quoted key/value assignment (JS/TS/YAML): `token: "..."`, `apiKey = "..."`.
  // Fixes the word-boundary bug found live against a real estate: \b before
  // the keyword required the identifier to *start* with it, which real env
  // vars almost never do -- they're namespaced (VITE_FIREBASE_API_KEY,
  // authToken), so the boundary sat on the wrong side and 33 of 34 real
  // credential lines swept from a real estate went unmatched. Matching a
  // keyword anywhere an identifier *ends* fixes that, at the cost of also
  // matching a keyword mid-word inside a longer run (tokenizer, secretary,
  // passwordless) -- (?![a-z]) closes that gap by requiring the character
  // right after the keyword (and after an optional trailing plural s) not
  // continue the same lowercase word. The `s?` matters on its own: a bare
  // (?![a-z]) with no plural allowance rejects `credentials`/`secrets`/
  // `tokens`/`apiKeys` outright, which is the *more* common naming form in
  // JS/TS/YAML config -- found live via a second real-estate sweep after
  // this pattern shipped without one.
  /[a-z0-9_]*(?:api[_-]?key|secret|token|password|credential)s?(?![a-z])[a-z0-9_]*\s*[:=]\s*['"][^'"]{12,}['"]/i,
  // Unquoted env-style assignment: `API_KEY=...`, `VITE_FIREBASE_API_KEY=...`.
  // Same fix, uppercase-only domain (real env-file keys are
  // SCREAMING_SNAKE_CASE) -- which already keeps this one clear of the
  // English-word collisions the lowercase pattern above has to guard
  // against explicitly.
  /[A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[A-Z_]*=\S{12,}/
];

const SKIP_FILES = new Set(['.env', '.env.local', '.env.production', 'id_rsa']);
// Fix round 1 (coordinator finding): the original 8-extension list already
// silently excluded most of the real estate's own language mix -- a real C++
// repo's ClipboardWriter.cpp/.h were never opened at all. Widened to cover
// every language the cowpath notes' own real examples were written in.
// `.lua` is past the coordinator's named floor list but found the same way
// the rest of this list was found: verification against the real estate
// turned up a genuine 29-file Lua project, still coming back zero-symbol
// after every other language on the list was added. Same class of gap, same
// fix.
const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.cs',
  '.cpp', '.cc', '.h', '.hpp', '.java', '.rs', '.rb', '.swift', '.kt', '.php', '.lua'
]);

// Fix round 1 (coordinator finding): CODE_EXT already listed .cs and .go
// before this file's own scan even opened them -- the miss was never "which
// files get read," it was that this pattern only recognizes two shapes
// (JS/TS `export function`, Python `def`) out of the many the estate's own
// real repos are written in. A real C#-only repo returned 0 symbols
// extracted, a repo whose files were being opened correctly all along,
// because nothing here could recognize `private static extern IntPtr
// GetDC(...)` as a symbol. 23 of 83 real cards came back with zero symbols
// for this reason, and the design ranks symbol-less cards near-unreachable
// (code fields outrank prose, and a card with no symbols has no code field
// to rank on).
//
// This is not a parser and does not try to be one -- it is a set of
// per-shape patterns, one per language family the estate actually contains,
// combined via alternation. Over-capturing a stray identifier costs a
// little rank noise; missing a repo's entire symbol surface costs the whole
// card. Each alternative uses a *named* capture group so the caller below
// can find whichever one fired without hardcoding a numbered index per
// pattern -- adding a language later means adding an alternative here, not
// renumbering every consumer.
const SYMBOL_RE = new RegExp([
  // JS/TS/JSX: the three real export shapes plus a plain (non-exported)
  // function declaration. `^` anchors the plain-function alternative to
  // line start, which is also what stops it from re-matching a line that
  // already matched the export-function alternative first (that line does
  // not start with bare whitespace-then-`function` -- it starts with
  // `export`).
  String.raw`export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s+(?<jsExportFn>[A-Za-z_$][\w$]*)`,
  String.raw`export\s+(?:default\s+)?const\s+(?<jsExportConst>[A-Za-z_$][\w$]*)\s*=`,
  String.raw`export\s+(?:default\s+)?(?:abstract\s+)?class\s+(?<jsExportClass>[A-Za-z_$][\w$]*)`,
  // Requires the trailing `(` (unlike the export-function alternative above,
  // where the leading `export ` keyword already disambiguates the line):
  // without it, this alternative would also partially match Lua's
  // dot/colon-scoped `function Table.name(...)` sugar (JS charset can't
  // cross the `.`, so it would capture only `Table` and, because it comes
  // first in this list, would win before the Lua-specific alternative below
  // ever got a chance to capture the fuller, more useful `Table.name`).
  String.raw`^\s*function\s*\*?\s+(?<jsPlainFn>[A-Za-z_$][\w$]*)\s*\(`,
  // Python `def`/`class`, extended to also cover Ruby's identical keywords
  // (`def`, optionally `self.`-qualified; `class`) -- both languages spell
  // the same two shapes the same way, so one pair of patterns serves both.
  // Ruby identifiers can trail with `?`/`!` (`valid?`, `save!`); Python's
  // never do, so allowing it costs nothing there.
  String.raw`^\s*def\s+(?:self\.)?(?<defKeyword>[A-Za-z_][\w?!]*)`,
  String.raw`^\s*class\s+(?<classKeyword>[A-Za-z_][\w?!]*)`,
  // Go: `func Name(...)` and `func (r *Receiver) Name(...)` method form.
  String.raw`^\s*func\s+(?:\([^)]*\)\s*)?(?<goFunc>[A-Za-z_]\w*)\s*\(`,
  // Rust, Swift, Kotlin: all three trail the name with a paren-requirement
  // added for the same reason `jsPlainFn` above needed one -- without it,
  // any of these would also partial-match a dotted/colon-scoped name from a
  // later, more specific alternative (the same class of bug `phpFunction`
  // had below before this fix round, found live via a real Lua fixture repo)
  // and win first purely by list position, not by being the better match.
  String.raw`^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(?<rustFn>[A-Za-z_]\w*)\s*\(`,
  String.raw`^\s*(?:(?:public|private|internal|fileprivate|open)\s+)?(?:static\s+|final\s+|override\s+)*func\s+(?<swiftFunc>[A-Za-z_]\w*)\s*\(`,
  String.raw`^\s*(?:(?:public|private|internal|protected)\s+)?(?:suspend\s+)?fun\s+(?<kotlinFun>[A-Za-z_]\w*)\s*\(`,
  // PHP. This is the pattern that actually caught a real fixture repo's Lua
  // lines before the paren requirement was added: PHP and Lua both spell a
  // function declaration with the literal word `function`, this alternative
  // is checked before the Lua-specific one below, and without `\s*\(` it
  // stopped as soon as it found a bare name -- `function EvolutionManager.
  // GetEvolutionCost(...)` matched here and captured only `EvolutionManager`,
  // never reaching the Lua alternative that would have captured the fuller,
  // more useful `EvolutionManager.GetEvolutionCost`.
  String.raw`^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?(?<phpFunction>[A-Za-z_]\w*)\s*\(`,
  // Lua: `local function name(...)` and the dot/colon table-method sugar
  // (`function Table.name(...)`, `function Table:name(...)`) -- found live
  // via a real 29-file Lua fixture repo, still zero-symbol after every
  // language on the coordinator's own named list was added. The captured
  // name can carry a
  // `Table.`/`Table:` prefix rather than just the bare method name; left
  // whole rather than split, since a substring search still finds it either
  // way and splitting risks losing the table-scoping context that is often
  // the more informative part of a Roblox-style module name.
  String.raw`^\s*(?:local\s+)?function\s+(?<luaFunc>[A-Za-z_][\w.:]*)\s*\(`,
  // C-family (C#, C++, Java) type declarations: `class`/`struct`/`interface`/
  // `record`/`enum`, any leading access/other modifiers optional. Catches
  // ClipboardWriter.cpp's anonymous-namespace `struct DecodedBitmap` and
  // every C#/Java class the estate carries.
  String.raw`^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|final)\s+)*(?:class|struct|interface|record|enum|trait)\s+(?<cFamilyType>[A-Za-z_]\w*)`,
  // C-family (C#, C++, Java) method/function declarations: a name
  // immediately followed by `(`, preceded by a type or access modifier --
  // never a bare call site, because a bare call has no such prefix (the
  // capture group cannot fire on the same identifier the mandatory leading
  // char already started consuming). An optional leading run of `[Attr]`
  // segments absorbs C#-style same-line attributes
  // (`[DllImport("user32.dll")] private static extern IntPtr GetDC(...)`,
  // exactly the shape that made a real C#-only repo's own P/Invoke
  // declarations unreadable under the old pattern despite `.cs` already
  // being scanned).
  // The leading negative lookahead rejects the one real false-positive class
  // this shape is otherwise blind to: a control-flow keyword immediately
  // followed by a call with no parens in between reads identically to a
  // modifier-then-name declaration (`else GlobalFree(hDibV5);` -- found live
  // against ClipboardWriter.cpp -- has the exact same "word, space,
  // identifier, (" shape as `private static extern IntPtr GetDC(...)`, and
  // nothing about the two is distinguishable without knowing these are
  // reserved words). None of the excluded words are ever a legitimate return
  // type or access modifier, so this can only remove false positives.
  //
  // The generic type-run charset (`[\w:<>,` ... `]`) deliberately uses
  // `[ \t]`, not `\s`, for its whitespace member -- `\s` matches newlines
  // too, and a non-greedy `*?` with no other constraint will happily cross
  // them looking for the next `NAME(` it can find. Found live: with `\s`
  // here, a Lua fixture's `end` (block-closer keyword, not on this
  // alternative's stoplist, and not meant to be) silently absorbed
  // `end\n\nfunction TagService:` as one "type prefix" spanning two
  // physical lines and three more alternatives down the list, and captured
  // only `untag` -- the trailing fragment of a name a single-line-scoped
  // `luaFunc` alternative earlier in the list would otherwise have matched
  // correctly and in full. Every real C-family declaration this pattern is
  // meant for lives on one physical line; restricting the charset to
  // same-line whitespace only removes that entire failure class rather than
  // trying to stoplist every keyword every other language might put before
  // a blank line.
  String.raw`^\s*(?:\[[^\]]*\]\s*)*(?!(?:if|else|while|for|foreach|switch|catch|return|throw|new|typeof|instanceof|delete|yield|await|case|do|try|finally|in|of|break|continue|goto|using|lock)\b)(?:(?:public|private|protected|internal|static|virtual|override|async|final|abstract|sealed|readonly|new|unsafe|extern|inline|constexpr|explicit|friend|template|const|volatile)\s+)*[A-Za-z_][\w:<>,\t *&[\]]*?\b(?<cFamilyMethod>[A-Za-z_]\w*)\s*\(`
].join('|'), 'gm');

// Every alternative above uses a distinct named group so exactly one is
// defined per match (the others are `undefined` -- alternation only ever
// fires one branch per match position). Reading whichever one fired means a
// new language pattern is a new alternative here, not a new numbered index
// to remember to check everywhere the old `m[1] || m[2]` shape used to live.
function firstGroup(groups) {
  for (const k in groups) if (groups[k] !== undefined) return groups[k];
  return undefined;
}

// Cost bounds for the code walk. Reading file bodies to look for secrets is
// the whole point, but an estate-wide index run touches ~86 repos and any
// one of them can carry a generated bundle or a data dump sitting under a
// CODE_EXT name. Skip outsized files rather than read them whole, and stop
// reading further file bodies once a repo has handed over an unreasonable
// number of them -- directory traversal stays cheap either way since
// node_modules/.git/dist are pruned before recursion.
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES_READ = 5000;
// Fix round 1 (coordinator finding), second-order regression: the widened
// SYMBOL_RE finds far more per file than the original two-shape pattern
// did, and the old 400 cap -- never hit in practice before this fix, so
// never calibrated against real data -- started silently truncating away
// exactly the symbols a sweep needed. Live on the real estate: one repo's
// (referred to here as `Aurora`) full symbol set is 2,050 (uncapped) and
// `computeStripeVerdict` / `trackBeginCheckout` / `EphemerisService` all sit
// well past index 400, so the old cap dropped every one of them and "stripe
// checkout" / "swiss ephemeris" both silently regressed to zero hits on a
// repo that unambiguously has the code. 6000 is calibrated against the real
// estate's own distribution, not picked round: it clears every repo below
// the heaviest four outliers with real margin (Aurora 2,050; ClipTool
// 4,049) while still bounding the true outliers (ClipCatcher 25,013; Atlas
// 14,008; MarketScanApp 13,675; UtilityFork 7,243, already excluded from
// ranking by default as `foreign`) rather than indexing them uncapped.
// `scanTruncated`/`truncatedBy` cover file-level skips
// (oversized file, file-count cap); this is a separate, symbol-count cap
// with no equivalent honesty signal on the card today -- a real gap, not
// silently fixed here, and worth its own follow-up.
const MAX_SYMBOLS = 6000;

export function looksSecret(line) {
  return SECRET_PATTERNS.some(re => re.test(line));
}

function git(dir, args) {
  if (!dir) return null;
  try {
    return execFileSync('git', ['-C', dir, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

function readDeps(dir) {
  if (!dir) return [];
  const p = path.join(dir, 'package.json');
  if (!fs.existsSync(p)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Object.keys({ ...j.dependencies, ...j.devDependencies });
  } catch { return []; }
}

// Same size guard as the code walk below, applied here for consistency:
// README.md/CLAUDE.md are read whole with no cap otherwise, and while a
// multi-hundred-KB README is rare, "rare" isn't "never" across ~86 repos.
// Oversized is treated the same as absent (empty list, no error) rather than
// threading a truncation signal through -- claims/gotchas are already capped
// to the first 10/15 lines, so the blast radius of silently skipping one is
// small compared to the code-symbol case Finding 2 was about.
// Returns { claims, truncated } rather than a bare array: a size-guard trip
// used to come back indistinguishable from "this repo genuinely has no
// README" -- both were `[]`, with no honesty signal anywhere on the card.
// `truncated` lets buildShallowCard fold this into the same
// scanTruncated/truncatedBy fields the code walk already reports, reusing
// 'maxFileBytes' since it is the identical guard value, just applied to a
// different file.
function readClaims(dir, { maxFileBytes = MAX_FILE_BYTES } = {}) {
  if (!dir) return { claims: [], truncated: false };
  const p = path.join(dir, 'README.md');
  if (!fs.existsSync(p)) return { claims: [], truncated: false };
  try {
    if (fs.statSync(p).size > maxFileBytes) return { claims: [], truncated: true };
  } catch { return { claims: [], truncated: false }; }
  const claims = fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.trim().startsWith('#') && !looksSecret(l))
    .slice(0, 10)
    .map(l => l.trim().slice(0, 160));
  return { claims, truncated: false };
}

// Same shape and same reasoning as readClaims above, for CLAUDE.md/gotchas.
function readGotchas(dir, { maxFileBytes = MAX_FILE_BYTES } = {}) {
  if (!dir) return { gotchas: [], truncated: false };
  const p = path.join(dir, 'CLAUDE.md');
  if (!fs.existsSync(p)) return { gotchas: [], truncated: false };
  try {
    if (fs.statSync(p).size > maxFileBytes) return { gotchas: [], truncated: true };
  } catch { return { gotchas: [], truncated: false }; }
  const gotchas = fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => /^\s*[-*]\s+\*\*/.test(l) && !looksSecret(l))
    .slice(0, 15)
    .map(l => l.replace(/^\s*[-*]\s+/, '').slice(0, 200));
  return { gotchas, truncated: false };
}

// caps is overridable so tests can trip truncation deterministically without
// materializing thousands of fixture files or a real 512KB one.
function scanCode(dir, { maxFileBytes = MAX_FILE_BYTES, maxFilesRead = MAX_FILES_READ } = {}) {
  const symbols = new Set();
  const entrypoints = [];
  // Split by *why* a file contributed nothing: filename-based (.env-shaped,
  // never opened) vs content-based (opened, a line inside it looked secret).
  // skippedSecretFiles is kept as their sum for back-compat with callers
  // that only want the total.
  let skippedByFilename = 0;
  let skippedByContent = 0;
  let filesRead = 0;
  let scanTruncated = false;
  const truncatedBy = new Set();

  const walk = (d, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { walk(abs, depth + 1); continue; }
      // Filename-based skip is a directory-entry check, not a file read --
      // keep counting it accurately even past the file-read cap below, so
      // the counter stays trustworthy in exactly the large repos where the
      // cap is most likely to have tripped.
      if (SKIP_FILES.has(e.name) || e.name.startsWith('.env')) { skippedByFilename++; continue; }
      if (!CODE_EXT.has(path.extname(e.name))) continue;
      // Entrypoint detection is also name-only -- keep collecting past the
      // cap too.
      if (/route\.(ts|js)$/.test(e.name) || /^(index|main|cli)\./.test(e.name)) {
        entrypoints.push(path.relative(dir, abs).split(path.sep).join('/'));
      }
      // Past this point every branch would read the file body. Once the cap
      // trips, stop reading contents but keep traversing/counting the cheap
      // stuff above -- the alternative (an early `return` out of the whole
      // walk) is what silently broke skippedSecretFiles for the rest of a
      // capped-out repo.
      if (filesRead >= maxFilesRead) { scanTruncated = true; truncatedBy.add('maxFilesRead'); continue; }
      let stat;
      try { stat = fs.statSync(abs); } catch { continue; }
      if (stat.size > maxFileBytes) { scanTruncated = true; truncatedBy.add('maxFileBytes'); continue; }
      let body;
      try { body = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      filesRead++;
      if (body.split('\n').some(looksSecret)) { skippedByContent++; continue; }
      for (const m of body.matchAll(SYMBOL_RE)) {
        const name = firstGroup(m.groups);
        if (name) symbols.add(name);
      }
    }
  };

  walk(dir, 0);
  // The symbol-count cap itself never set an honesty signal -- it just cut
  // the set down with `.slice(0, MAX_SYMBOLS)` below and reported
  // scanTruncated: false whenever no file-level cap had also tripped.
  // Measured live: MarketScanApp and Atlas both claimed a complete scan
  // while carrying roughly 43% of their real symbol count. Checked against
  // the pre-slice size, since slicing first would make the trip
  // undetectable (the sliced length is always <= MAX_SYMBOLS by
  // construction).
  if (symbols.size > MAX_SYMBOLS) {
    scanTruncated = true;
    truncatedBy.add('maxSymbols');
  }
  return {
    symbols: [...symbols].slice(0, MAX_SYMBOLS),
    entrypoints: entrypoints.slice(0, 60),
    skippedSecretFiles: skippedByFilename + skippedByContent,
    skippedByFilename,
    skippedByContent,
    scanTruncated,
    truncatedBy: [...truncatedBy]
  };
}

// caps: optional { maxFileBytes, maxFilesRead } override, threaded down to
// scanCode/readClaims/readGotchas. Exists so a test can trip truncation
// deterministically against a small fixture instead of needing a real
// 512KB file or 5000 real files on disk.
export function buildShallowCard(repo, now = new Date(), caps = {}) {
  const base = {
    schemaVersion: 1,
    repo: repo.name,
    origin: repo.origin,
    remote: repo.remote ?? null,
    canonical: repo.canonical ?? true,
    siblings: repo.siblings ?? [],
    diverged: repo.diverged ?? false,
    provenance: repo.provenance ?? 'own',
    // Not verified/collapsed unless the record says so: a record that never
    // went through classifyProvenance or collapseDuplicates (e.g. a
    // remote-only listing) must not silently read as "we checked."
    provenanceKnown: repo.provenanceKnown ?? false,
    dedupVerified: repo.dedupVerified ?? false,
    indexedAt: now.toISOString()
  };

  // Remote-only repos (origin: 'remote', path: null) have no local clone to
  // walk -- there is nothing to read deps/symbols/claims/gotchas from, and
  // no git working copy to ask for HEAD. Report that honestly as
  // depth: 'shallow-remote' rather than pretending a local scan ran.
  if (!repo.path) {
    return {
      ...base,
      path: null,
      head: null,
      lastCommit: null,
      depth: 'shallow-remote',
      stack: { framework: null, services: [] },
      deps: [],
      entrypoints: [],
      symbols: [],
      claims: [],
      gotchas: [],
      recallHits: 0,
      skippedSecretFiles: 0,
      skippedByFilename: 0,
      skippedByContent: 0,
      scanTruncated: false,
      truncatedBy: []
    };
  }

  const deps = readDeps(repo.path);
  const {
    symbols, entrypoints, skippedSecretFiles,
    skippedByFilename, skippedByContent, scanTruncated: codeScanTruncated, truncatedBy: codeTruncatedBy
  } = scanCode(repo.path, caps);
  const { claims, truncated: claimsTruncated } = readClaims(repo.path, caps);
  const { gotchas, truncated: gotchasTruncated } = readGotchas(repo.path, caps);

  // One honesty signal for the whole card, not three separate ones: a
  // README/CLAUDE.md size-guard trip used to come back as a bare `[]`,
  // indistinguishable from "this repo genuinely has none" -- the same class
  // of silent gap MAX_SYMBOLS had inside scanCode itself. Folded in here so
  // scanTruncated/truncatedBy mean "some part of this card's scan was cut
  // short," full stop, regardless of which guard did the cutting.
  const scanTruncated = codeScanTruncated || claimsTruncated || gotchasTruncated;
  const truncatedBySet = new Set(codeTruncatedBy);
  if (claimsTruncated || gotchasTruncated) truncatedBySet.add('maxFileBytes');
  const truncatedBy = [...truncatedBySet];

  // enumerateLocal already computes head/lastCommit as part of its own git
  // pass (folded in so collapseDuplicates can detect divergence) and passes
  // both through on every record it returns. Reuse them here instead of
  // shelling out to git a second time for data the caller already has --
  // two fewer subprocesses per local repo across an estate-wide index run.
  // Checked with `in`, not a truthiness/undefined test: a repo with zero
  // commits legitimately precomputes head/lastCommit as null, and that must
  // still count as "precomputed, don't re-fetch," not fall through to a
  // redundant (and equally fruitless) git call. Both-or-neither, since
  // enumerateLocal always sets the pair together -- a caller that never
  // ran that pass (e.g. a hand-built test fixture) has neither key and
  // falls through to the original git-call path unchanged.
  let head, lastCommit;
  if ('head' in repo && 'lastCommit' in repo) {
    ({ head, lastCommit } = repo);
  } else {
    head = git(repo.path, ['rev-parse', '--short', 'HEAD']);
    const rawLastCommit = git(repo.path, ['log', '-1', '--format=%ct']);
    lastCommit = rawLastCommit ? Number(rawLastCommit) : null;
  }

  return {
    ...base,
    // forward slashes everywhere: the cowpath's first pass silently returned the
    // wrong shape because Windows separators broke path splitting, and nothing errored
    path: repo.path.split(path.sep).join('/'),
    head,
    lastCommit,
    depth: 'shallow',
    stack: {
      framework: deps.find(d => ['next', 'react', 'vue', 'svelte'].includes(d)) || null,
      services: deps.filter(d => /firebase|stripe|openai|anthropic|google/.test(d))
    },
    deps,
    entrypoints,
    symbols,
    claims,
    gotchas,
    recallHits: 0,
    skippedSecretFiles,
    skippedByFilename,
    skippedByContent,
    scanTruncated,
    truncatedBy
  };
}
