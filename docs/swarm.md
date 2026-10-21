# Swarm mode guide

Swarm mode builds decomposable work with several Claude Code subagents in
parallel, each in its own Git worktree, each finishing through the usual
LeanLoop evidence gates. Your own Claude Code session is the lead. LeanLoop
does not start model sessions and does not change permissions: it validates
the plan, manages worktrees and branches, writes worker briefs, and gates
acceptance, merges, and the final verification. The design and its evidence
are in [swarm-design.md](swarm-design.md).

## When to use it

Use swarm mode when the work splits into parts with their own checks and few
shared files: a new app with a separate API, UI, and data layer, or several
independent features. Use guided mode (`/leanloop:work`) for coupled or
sequential changes, debugging, and research code. Parallel runs cost more
tokens than one session; the lead recommends a mode and you decide.

## Requirements

- Claude Code with the LeanLoop plugin installed, and Git with worktree support.
- Node.js as required by the package (see `engines` in package.json).
- A Git repository with at least one commit, `leanloop init` done, and checks
  recorded in `leanloop.json` (one or more per package).
- The bootstrap committed: runs start from HEAD, so uncommitted files in your
  checkout are not part of the run (`swarm start` warns about them).
- Recommended: Claude Code's sandbox, which needs WSL2, Linux, or macOS. On
  native Windows, subagents run shell commands unsandboxed.

## The flow

Run `/leanloop:build "your idea"`. The lead then:

1. Recommends guided or swarm mode, with reasons.
2. Writes `spec.md` (acceptance criteria, non-goals, constraints) and asks you
   only about real ambiguities.
3. Writes `plan.json` and runs `leanloop swarm validate plan.json`.
4. Shows the packages, their order, the worker count (at most 4 at once), and
   every permission the run needs, and waits for your approval.
5. Creates the skeleton, a check per package, contracts, and sealed acceptance
   tests under `.leanloop/sealed/`, and commits the bootstrap with your approval.
6. Runs `swarm start`, then for each ready package `swarm prepare` and hands the
   brief to a subagent. After a subagent reports, it runs `swarm accept` and
   `swarm merge`. Failures go back to that package's subagent.
7. Runs `swarm verify`, has the `leanloop:code-reviewer` agent review the
   integration diff, and reports the evidence.
8. Asks you before merging the integration branch into your branch, pushing,
   deploying, using credentials, adding dependencies, running GPU jobs, or
   moving hardware.

## plan.json

```json
{
  "version": 1,
  "spec": "spec.md",
  "packages": [
    {
      "id": "api",
      "goal": "Serve the todo list over HTTP",
      "ownedPaths": ["server", "tests/server"],
      "dependsOn": [],
      "checks": ["server-tests"],
      "acceptance": ["GET /todos returns the stored items as JSON"],
      "contracts": ["docs/api.md"]
    },
    {
      "id": "web",
      "goal": "Show and add todos in the browser",
      "ownedPaths": ["web/**"],
      "dependsOn": ["api"],
      "checks": ["web-tests"],
      "acceptance": ["Adding a todo shows it in the list after reload"]
    }
  ],
  "integrationChecks": ["all-tests"],
  "sealedChecks": ["acceptance"]
}
```

- `id`: lowercase identifier, unique, not `integration`.
- `ownedPaths`: project-relative POSIX paths (a directory or file covers
  everything below it) or globs with `*`, `**`, and `?`. Each must start with a
  literal name, and no two packages may overlap. Overlap is judged on the
  literal prefix, ignoring letter case (`src/api` and `src/API` are one folder
  on Windows and macOS), so `web/**/*.js` and `web/**/*.css` count as
  overlapping: split ownership by directory. `.git`, `.leanloop`, and
  `leanloop.json` cannot be owned. Nor can the files that define an
  integration check, a sealed check, or another package's check: the paths
  its command names and runner files such as `package.json` or
  `jest.config.*` in its working directory. A package may own its own check's
  runner when no other package or integration check uses it.
- `dependsOn`: package ids; the graph must have no cycles.
- `checks`, `integrationChecks`, `sealedChecks`: names from `leanloop.json`.
  Every package needs at least one check. A sealed check cannot also be a
  package or integration check.
- `acceptance`: 1 to 10 criteria per package.
- `contracts`: optional paths a worker reads but does not change unless it
  owns them. Missing contracts produce a warning.
- At most 20 packages.

## Sealed acceptance tests

Sealed tests live in `.leanloop/sealed/` in your main checkout, which Git
ignores and no worktree contains. A check command cannot expand environment
variables, so a sealed check runs a small committed runner that reads
`LEANLOOP_SEALED_DIR`:

```js
// scripts/run-sealed.mjs, recorded with: leanloop add-check acceptance -- node scripts/run-sealed.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.LEANLOOP_SEALED_DIR;
if (!dir) { console.error('Run through leanloop swarm verify.'); process.exit(2); }
const files = fs.readdirSync(dir).filter(name => name.endsWith('.test.mjs')).map(name => path.join(dir, name));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
```

`swarm verify` sets `LEANLOOP_SEALED_DIR` only for sealed checks; merge checks
run without it.

## Commands

All commands print JSON and accept `--project DIR`.

| Command | What it does |
|---|---|
| `swarm validate PLAN` | Reports every plan error, the dependency waves, and the largest useful worker count. |
| `swarm start PLAN` | Validates, creates branch `leanloop/swarm/RUN` at HEAD and its worktree at `.leanloop/worktrees/RUN/integration`. Your branch and checkout stay as they are. |
| `swarm prepare RUN PACKAGE` | Once every dependency has merged: creates branch `leanloop/swarm/RUN-PACKAGE` and its worktree from the integration tip, writes a `leanloop.json` with only that package's checks, runs `init`, and prints the brief. Repeating it reprints the brief. For a package in rework it first merges the current integration tip into the package branch; if that conflicts, it aborts and reports `REFRESH_CONFLICT` for you to decide. |
| `swarm accept RUN PACKAGE` | Requires the worktree's LeanLoop task to be done with fresh checks and evidence (a new task after rework), started with the brief's goal, acceptance criteria (same text and order), and scope, and every committed or uncommitted change to lie inside the owned paths; `leanloop.json` must be unchanged and no `.leanloop/` file may be committed or staged. Then commits the changes on the package branch with your Git identity. |
| `swarm merge RUN PACKAGE` | Merges an accepted package with `--no-ff` once its dependencies have merged, then runs its checks and the integration checks. A conflict aborts the merge; a failed check resets the integration branch to the commit recorded before the merge. Both mark the package for rework. If a call was interrupted after Git merged, running merge again resumes the checks for that same merge; a package merged into the integration branch any other way is refused. |
| `swarm verify RUN` | After every package has merged, runs the sealed checks in the integration worktree. |
| `swarm status [RUN]` | Lists runs, or shows one run's packages, ready packages, rework details, and verification. |
| `swarm abandon RUN --reason TEXT` | Records the reason and every branch tip, then removes the run's clean worktrees and their branches. A worktree with uncommitted changes or untracked files (worker output not yet accepted) is kept with its branch and reported; commit or discard those changes and run abandon again. Run state stays in `.leanloop/swarm/RUN/state.json`. |

State lives in `.leanloop/swarm/RUN/state.json`. A per-run lock stops two
helper calls from changing it at once; if a crashed call leaves
`.leanloop/swarm/RUN/lock.json` behind, the error says whether its process is
still running, and you delete the file only when no LeanLoop command is.

To finish a successful run: review the integration branch, merge it into your
branch yourself (or ask the lead to, explicitly), then `swarm abandon RUN
--reason "merged"` to remove the worktrees and run branches.

## Enforced versus cooperative

Enforced by the helpers, every time they run:

- Plan structure: disjoint owned paths, no cycles, known checks, limits.
- Preparation order: a package starts only after its dependencies merge.
- Acceptance: a done task for the planned goal and criteria with fresh
  evidence, and no change outside the owned paths, to the check
  configuration, or to tracked files under `.leanloop/`.
- Merge order, merge checks, and rollback of the integration branch to the
  commit recorded before the merge.
- Sealed tests never committed into a package branch; verification only on a
  fully merged run.
- Abandon records the reason and branch tips before deleting anything, keeps
  worktrees that hold uncommitted work, removes only the run's own worktree
  entries (not a repository-wide `git worktree prune`), and never deletes the
  branch checked out in your main worktree.

Cooperative, relying on the lead, the subagents, and Claude Code:

- Workers staying inside their worktree. A subagent with shell access can read
  `.leanloop/sealed`, edit other worktrees, or run Git; the helpers detect
  out-of-scope results at accept time but cannot prevent actions.
- The concurrency limit of 4 and the approval steps, which the build skill
  asks the lead to follow.
- Evidence quality: proofs and reviews are attestations, as in guided mode.
- Network, credentials, and process isolation: Claude Code's permission rules
  and sandbox, not LeanLoop.

## Limits

- Files Git ignores are neither checked by accept nor merged. Abandon removes
  clean worktrees with Git-ignored files inside them (build outputs, installed
  dependencies, LeanLoop task state).
- Overlap detection is conservative for globs that share a directory.
- Ownership is per path, so a package cannot share a file with another; put
  shared files in a contract owned by one package or created at bootstrap.
- Check runs inherit the user's environment and permissions; they are not
  sandboxed by LeanLoop.
- Long ML jobs and hardware steps have no special support yet; see
  [swarm-design.md](swarm-design.md).
