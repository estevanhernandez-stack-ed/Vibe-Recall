#!/usr/bin/env node
// The hook's real entry point. Deliberately thin, and importing nothing but
// banner.mjs -- that is the whole point of this file existing.
//
// engine/cli.mjs's `banner` subcommand pulls in the CLI's entire import
// graph at load time (config.mjs, corpus.mjs, remote.mjs, cards.mjs --
// several of which reach node:child_process for git/gh calls), even though
// the banner path itself never calls any of that code. That made
// tests/banner-budget.test.mjs's import-graph walk prove a budget the hook
// wasn't actually bound by: the test walked banner.mjs, but hooks/hooks.json
// ran cli.mjs, a different, fatter graph. It was behaviourally inert only by
// luck -- nothing in those unused modules happens to run a top-level
// side-effecting shell-out today, but nothing was stopping one from being
// added tomorrow and running on every single prompt the user types, unseen
// by the test that exists to forbid exactly that.
//
// This file exists so the graph the budget test walks and the graph the
// hook actually loads are the same graph. hooks/hooks.json points here, not
// at cli.mjs. cli.mjs's own `banner` subcommand still exists for manual
// testing (`node engine/cli.mjs banner "<text>"`) -- it is just not what the
// hook runs.
import { banner } from './banner.mjs';

// Duplicated, not imported, from engine/cli.mjs's own stdin handling: a
// shared helper module would be one more import than "nothing but
// banner.mjs", and the whole guarantee this file provides rests on its
// dependency graph being provably identical to banner.mjs's. The candidate
// field order mirrors the resolved UserPromptSubmit contract -- "user_input"
// first, corroborated from two independent sources (a Claude Code
// specialist agent's read of the reference, and vibe-wrap's shipped
// SessionEnd hook using the same snake_case stdin-JSON convention) -- with
// the other candidates kept as fallback insurance in case that contract is
// still wrong, and a raw-text fallback if the payload isn't JSON at all.
//
// Also pulls `cwd` off the same payload -- the documented UserPromptSubmit
// shape (see the header comment) already carries it alongside user_input.
// A non-JSON payload (the raw-text fallback branch) has no structured cwd to
// read, so it comes back null there, same as if the field were simply
// absent; banner.mjs treats a null/missing cwd as "apply no self-exclusion,"
// a legitimate no-op, not an error.
function extractContext(raw) {
  if (!raw) return { prompt: '', cwd: null };
  try {
    const payload = JSON.parse(raw);
    const prompt = payload.user_input ?? payload.prompt ?? payload.user_prompt ?? payload.userPrompt ?? '';
    return { prompt, cwd: payload.cwd ?? null };
  } catch {
    return { prompt: raw, cwd: null };
  }
}

// Stream-based rather than fs.readFileSync(0, ...) so this file has zero
// import statements beyond banner.mjs -- process.stdin is a Node global,
// not something that needs importing. A TTY stdin (a human ran this file
// directly, nothing piped in) resolves empty immediately rather than
// hanging on input that will never arrive.
function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  // UserPromptSubmit exit semantics: exit code 2 blocks the prompt AND
  // erases the user's already-typed text; any other nonzero exit is
  // non-blocking but still an unwanted error. A recall advisory has no
  // business doing either, so nothing on this path may throw past this
  // boundary -- an unexpected failure (a stdin read error, a malformed
  // payload, a card shape that breaks formatting, anything not already
  // guarded inside banner.mjs) degrades to silence and a clean exit 0,
  // never a crash the harness has to represent to the user somehow.
  try {
    const raw = await readStdin();
    const { prompt, cwd } = extractContext(raw);
    const out = banner(prompt, process.env, cwd);
    if (out) console.log(out);
  } catch {
    // Swallow deliberately. Silence is always the safe fallback for a
    // hook; a stack trace on stderr is not worth risking exit 2.
  }
}

main();
