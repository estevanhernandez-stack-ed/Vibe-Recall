---
name: first-run-setup
description: Internal skill invoked on first vibe-recall use when no config exists, or directly on "set up vibe-recall", "init vibe-recall". Captures estateRoot, githubAccounts, walls (none pre-seeded -- ask explicitly), and exclude, then writes config.json. Idempotent -- re-running refreshes stale values without touching the index.
---

# vibe-recall first-run-setup

1. Gather (AskUserQuestion where not derivable from context):
   - `estateRoot` -- the directory containing the user's repos. Offer a sensible guess (the
     parent of the current repo, or the current directory if it already looks like an
     estate root) and confirm it rather than assuming silently.
   - `githubAccounts[]` -- GitHub account/org logins to enumerate for remote-only repos via
     `gh repo list`. Optional; an empty list means local-only indexing, stated once as not
     an error. **Warn before asking:** once an account is configured here, any repo whose
     GitHub org matches a configured wall is enforced and dropped from indexing --
     `engine/remote.mjs` checks the account name and the URL owner segment, not just
     individual repo names. Ask for walls (below) with that in mind, not as an afterthought.
   - `walls[]` -- tenant path prefixes that must never be indexed, never ranked, never named
     anywhere the index writes. **No wall ships pre-seeded** -- `engine/config.mjs`'s
     `DEFAULT_WALLS` starts empty, so this estate has zero protection until the user
     configures one here. Ask explicitly and explain what a wall is before asking for
     values: a neutral example is an employer's directory name (e.g. an estate laid out as
     `Projects/personal-app/` next to `Projects/<employer-name>/` would wall the latter).
     Anything written here is enforced absolutely -- there is no override flag anywhere in
     the plugin. (If `engine/config.mjs`'s `DEFAULT_WALLS` is ever re-seeded by a future
     release, the union at load time adds that seed on top of whatever the user configures
     here; it is a floor, never removable by user config, but there is no floor by default
     today -- the estate's protection is entirely what gets written in this step.)
   - `exclude[]` -- additional path segments to skip beyond the built-in underscore-prefix
     rule (`_scratch`, `_gitnexus-runner`, any `_*` directory).

   Do not ask for `authors` -- `engine/corpus.mjs`'s `discoverAuthors`, run as part of every
   `:index`, finds git identities that repeat across two or more estate repos and unions
   them with anything explicitly configured, so first-run setup has nothing useful to
   prompt for there yet. (`engine/config.mjs`'s own `authors` handling is narrower and does
   not do this: a single `git config` read on `estateRoot`, used only as a fallback when
   `authors` is empty in `config.json` -- not a cross-repo scan.) If a genuine repo of the
   user's later gets misclassified `foreign`, that is when `authors` gets edited by hand
   (see skills/vitals/SKILL.md).

2. Write the config to the resolved data home as `config.json` (`${CLAUDE_PLUGIN_DATA}/config.json`,
   else `~/.claude/plugins/data/vibe-recall/config.json` -- see `engine/datahome.mjs`),
   shaped to `schemas/config.schema.json`: `{ schemaVersion: 1, estateRoot, githubAccounts,
   walls, exclude }`.

3. Validate before reporting success -- `engine/config.mjs` exports `validateConfig`. A
   config that fails schema validation does not get written; report the errors and ask
   again rather than writing something `loadConfig` would later throw on.

4. Re-running this skill overwrites only `config.json`. It never touches `cards.json` --
   refreshing the index after a config change is a separate, explicit `/vibe-recall:index`.
