---
description: Build or refresh the estate index
---

Read skills/guide/SKILL.md for the invariants (walls, shapes-not-content), then run:

    node engine/cli.mjs index

from `plugins/vibe-recall/`. Report the repo count, and if the CLI names any diverged clone
pairs, surface them plainly -- do not pick a canonical copy on the user's behalf. No
dedicated skill backs this command; running the CLI subcommand and reporting its own output
honestly is the whole job.
