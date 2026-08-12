import fs from 'node:fs';
import path from 'node:path';

// Structural checks on the skills/commands layer -- the only mechanical
// check this layer gets, so it carries more weight than usual. It cannot
// verify the prose is *good*, but it can verify the load-bearing claims
// (the trust rule, the no-invented-flags rule, the no-invented-subcommand
// rule) cannot silently rot as the files are edited later.

const SKILLS = ['guide', 'router', 'first-run-setup', 'sweep', 'brief', 'deepen',
  'vitals', 'session-logger', 'friction-logger'];

const COMMANDS = ['vibe-recall', 'index', 'sweep', 'brief', 'deepen', 'vitals'];

function skillBody(name) {
  return fs.readFileSync(path.join('skills', name, 'SKILL.md'), 'utf8');
}

function commandBody(name) {
  return fs.readFileSync(path.join('commands', `${name}.md`), 'utf8');
}

test.each(SKILLS)('%s has frontmatter with name and description', (s) => {
  const body = skillBody(s);
  expect(body.startsWith('---')).toBe(true);
  expect(body).toMatch(/^name:\s*\S+/m);
  expect(body).toMatch(/^description:\s*\S+/m);
});

test.each(COMMANDS)('command %s has frontmatter with a description', (c) => {
  const body = commandBody(c);
  expect(body.startsWith('---')).toBe(true);
  expect(body).toMatch(/^description:\s*\S+/m);
});

test('the brief skill states the live-verification rule verbatim', () => {
  const body = skillBody('brief');
  expect(body).toMatch(/index can suggest, only a live read can claim/i);
  expect(body).toMatch(/current HEAD/);
});

test('the brief skill hands off without inventing vibe-taker flags', () => {
  const body = skillBody('brief');
  expect(body).toMatch(/vibe-taker:capture/);
  expect(body).not.toMatch(/--repo|--feature/);
});

// Reviewer-caught gap (fix round 2): this loop checked SKILLS only, but the
// whole point of the assertion is that nothing anywhere invents a flag --
// command files are thin today, but "thin" is not the same as "structurally
// guaranteed," and a future edit to a command file could add a flag mention
// with nothing here to catch it.
test('no skill or command anywhere invents a --repo or --feature flag', () => {
  for (const s of SKILLS) {
    expect(skillBody(s)).not.toMatch(/--repo|--feature/);
  }
  for (const c of COMMANDS) {
    expect(commandBody(c)).not.toMatch(/--repo|--feature/);
  }
});

test('no skill body contains emoji', () => {
  for (const s of SKILLS) {
    expect(skillBody(s)).not.toMatch(/\p{Extended_Pictographic}/u);
  }
});

test('no command body contains emoji', () => {
  for (const c of COMMANDS) {
    expect(commandBody(c)).not.toMatch(/\p{Extended_Pictographic}/u);
  }
});

// The plan names /vibe-recall:deepen and /vibe-recall:brief as user-facing
// commands, but there is no `deepen` and no `brief` subcommand in
// engine/cli.mjs -- that work is the skill's own judgment (reading real
// source, deciding what's worth keeping), not a deterministic script. Every
// other skill that shells out must reference a subcommand that is real;
// these two must say plainly that no such subcommand exists rather than
// silently referencing one that would 404 at runtime.
test('the deepen skill states plainly that no deepen engine subcommand exists', () => {
  expect(skillBody('deepen')).toMatch(/no [`']?deepen[`']? engine subcommand/i);
});

test('the brief skill states plainly that no brief engine subcommand exists', () => {
  expect(skillBody('brief')).toMatch(/no [`']?brief[`']? engine subcommand/i);
});

test('every engine subcommand a skill references (node engine/cli.mjs <word>) actually exists in cli.mjs', () => {
  const cliSource = fs.readFileSync('engine/cli.mjs', 'utf8');
  // Derived from the real `commands` object in cli.mjs (each entry is a
  // 2-space-indented `word() {` method) rather than hardcoded, so this test
  // tracks cli.mjs instead of a copy of it that could drift.
  const actual = new Set(
    [...cliSource.matchAll(/^\s{2}(\w+)\(\)\s*\{/gm)].map(m => m[1])
  );
  // Guard: if the extraction regex ever stops matching cli.mjs's real
  // shape, fail loudly here instead of silently checking every skill
  // against an empty set (which would make every reference "pass" for the
  // wrong reason).
  expect(actual.size).toBeGreaterThan(0);
  expect(actual.has('index')).toBe(true);
  expect(actual.has('sweep')).toBe(true);
  expect(actual.has('queue')).toBe(true);
  expect(actual.has('vitals')).toBe(true);
  expect(actual.has('banner')).toBe(true);
  // And explicitly not the two invented-in-the-plan-but-never-built ones --
  // if either ever gets added for real, this line (not the loop below)
  // is what needs to change.
  expect(actual.has('deepen')).toBe(false);
  expect(actual.has('brief')).toBe(false);

  for (const s of SKILLS) {
    const body = skillBody(s);
    const referenced = [...body.matchAll(/cli\.mjs\s+(\w+)/g)].map(m => m[1]);
    for (const word of referenced) {
      expect(actual.has(word)).toBe(true);
    }
  }
});
