# LeanLoop

**One owner. Small context. Evidence before "done".**

LeanLoop is a Claude Code plugin. It gives Claude one working method for code
changes and a small local CLI that refuses to call a task done until checks
passed on the current source, every acceptance criterion has evidence, and any
edited test, changed check, or out-of-scope edit has been reviewed. It ships five
skills, two read-only reviewer agents, and the CLI. It adds no hooks, MCP
servers, model calls, telemetry, dependencies, or background processes, and it
never starts a model session. Claude still does the work.

By default it replaces role-chained multi-agent setups (planner → coder → tester
→ reviewer → reporter) with one owner that keeps the task in one context,
verifies with real commands, and keeps memory bounded. For large work that
splits into independent parts, an opt-in swarm mode lets your own session run
parallel subagents under the same gates. The [design](docs/design.md) and
[sources](SOURCES.md) explain the evidence behind each choice.

LeanLoop is cooperative evidence bookkeeping. It is not a sandbox, a security
boundary, an authenticated review system, or proof that tests are good.

LeanLoop was called lean-workflow until 0.4.0 and supported other agents until
0.5.0. See [migration](docs/migration.md) to move an existing install.

## Based on

LeanLoop is based on two public projects:

- **[ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd)** (MIT), a skill
  that stops coding agents from burying the answer. LeanLoop's reporting style
  comes from it: outcome first, numbered steps, one next action, short lists.
- **[WorldFlowAI/everything-claude-code](https://github.com/worldflowai/everything-claude-code)**,
  a Claude Code toolkit of agents, commands, skills, rules, and hooks, which builds
  on [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)
  (MIT). LeanLoop keeps the ideas behind its plugin packaging, reusable skills,
  and verify, checkpoint, and learn workflows, as bounded local commands with
  recorded evidence. It leaves out the role agents, broad hooks, and memory that
  only grows.

LeanLoop is an independent implementation: no code, prompts, or skill text were
copied from either project. Version 0.5.0 also reflects a review of 52 arXiv
papers on coding agents, and 0.6.0 adds the sources behind the code reviewer
and swarm mode; all are listed with their effect on the design in
[SOURCES.md](SOURCES.md).

## Install

Requirements: Claude Code, Node 22+ on `PATH`, and Git. Linux, macOS, and
Windows are supported; see [Windows](#windows) for its limits.

In Claude Code:

```text
/plugin marketplace add seyedalicheraghi/LeanLoop-
/plugin install leanloop@leanloop
```

Or from a shell:

```sh
claude plugin marketplace add seyedalicheraghi/LeanLoop-
claude plugin install leanloop@leanloop
```

The default scope is your user account, so every project can use it. A private
repository needs Git credentials that can read it. To try a local checkout
without installing, start Claude Code with `claude --plugin-dir /path/to/LeanLoop`.

The plugin adds a short description of each model-invoked skill and of both
agents to Claude's context in every session. The skill bodies load only when
used; `/leanloop:setup`, `/leanloop:audit`, `/leanloop:review`, and
`/leanloop:build` run only when you type them.

## Two modes

| | Guided (default) | Swarm (design A, opt-in) |
|---|---|---|
| Start | Ask for a change, or `/leanloop:work TASK` | `/leanloop:build "idea"` |
| Who works | Your Claude session, as the single owner | Your session as lead; package workers are ordinary Claude Code subagents |
| Use it for | Bug fixes, refactors, coupled or sequential changes, debugging, research code | Decomposable work: a new app with separate parts, or independent workstreams, each with its own checks |
| Avoid it for | Nothing in particular; it is the default | Tightly coupled changes, work where one part's design depends on another's, or a weak lead model directing cheaper workers |

Both modes share the same gates, reviewers, lessons, and audit; every swarm
worker is a guided-mode owner in its own Git worktree. Swarm runs cost more
tokens than one session, and published studies found team gains only on some
task structures (see [SOURCES.md](SOURCES.md#architecture-and-delegation)), so
the lead recommends a mode with reasons and you decide. LeanLoop has not
measured either mode's speed or quality on your work; use the
[evaluation procedure](docs/evaluation.md) for that.

In swarm mode LeanLoop starts no model sessions, passes no permission flags,
and changes no permission settings: the subagents run under your session's
normal permission rules and sandbox. LeanLoop only provides deterministic
helpers (`leanloop swarm validate|start|prepare|accept|merge|verify|status|abandon`)
and the procedure. See the [swarm guide](docs/swarm.md) and
[swarm design](docs/swarm-design.md).

## Use it in a project

1. **Set up once:** run `/leanloop:setup` in the project. It creates
   `leanloop.json` and an ignored `.leanloop/` folder, suggests checks from the
   project's own scripts, and records only the ones you approve.
2. **Work:** ask for a change as usual, or start with `/leanloop:work fix the
   pagination bug`. Claude follows the loop below for larger changes and keeps
   small ones small.
   For a change across components with their own checks, the skill maps them
   with a read-only helper, splits the work into smaller tasks, and checkpoints
   the remaining plan so the context can be cleared between steps.
3. **Review:** `/leanloop:review [target]` runs the `leanloop:code-reviewer`
   agent on uncommitted work, a commit range, a branch, or paths. It reads the
   change and its callers, runs read-only Git, runs project tests only if you
   allow it, and reports only findings it verified, each with `file:line` and a
   trigger. It cannot write files or use the network.
4. **Build:** `/leanloop:build "idea"` runs swarm mode: spec, package plan,
   your approval, then one worktree per package, merges in dependency order,
   and sealed acceptance tests at the end.
5. **Audit:** `/leanloop:audit` inventories the project's Claude Code setup for
   overhead and risky configuration. It is read-only and needs no setup.

Claude Code asks before running the CLI, like any command. Approve it in the
prompt, or add an allow rule for the command it shows.

## The loop

Claude runs the CLI as `node "${CLAUDE_PLUGIN_ROOT}/leanloop.mjs" COMMAND`. You
can run the same commands yourself from a checkout (`node leanloop.mjs COMMAND`).

```text
status / lessons        resume: task state, next action, project lessons
start GOAL --accept CRITERION... --scope PATH... [--risk high]
context "terms"         fallback: rank file names (12 paths, no contents)
check [--only NAME]     run configured checks; failures include an output excerpt
prove N "evidence"      record evidence for criterion N
escalate KIND SUMMARY --tried TEXT --recommend TEXT
                        stop and hand a decision to you (e.g. test-conflict)
resume --decision TEXT  record your decision, quoted, and reactivate the task
review --by ID --decision approve|request-changes --evidence TEXT
finish                  succeeds only when every gate below holds
checkpoint SUMMARY --next ACTION
learn LESSON --evidence TEXT [--anchor PATH] / forget ID
```

`prove`, `review`, and `resume` record attestations. The CLI cannot
authenticate who wrote them or whether they are true. The work skill tells
Claude to run `resume` only after you decide, quoting your words, and never on
its own.

## What "done" requires

`finish` refuses unless all of these hold for the current source fingerprint
(commit, staged changes, worktree changes, untracked files, and `leanloop.json`).
Each refusal has a code:

| Gate | Code | Why |
|---|---|---|
| No unresolved escalation | `ESCALATED` | An escalation is a real stop until you decide and `resume` records it |
| Checks are configured | `NO_CHECKS` | Nothing to verify against |
| The last check run covers this exact source | `STALE_EVIDENCE` | Any later edit makes old results stale |
| Every configured check passed | `INCOMPLETE_CHECKS` | Targeted runs alone do not finish a task |
| Every acceptance criterion has evidence on this source | `INCOMPLETE_ACCEPTANCE` | A green build is not the requested behavior |
| High-risk tasks have a current approving review | `REVIEW_REQUIRED` | Fresh-context review of risky changes |
| **Integrity findings have a current approving review** | `INTEGRITY_REVIEW_REQUIRED` | Agents under pressure edit tests or checks to pass |
| Edits outside `--scope` have a current approving review | `SCOPE_REVIEW_REQUIRED` | Agents edit beyond their task |

`INTEGRITY_REVIEW_REQUIRED` is triggered by any of:

- A test file that existed at `start` was modified, deleted, or retyped. New
  test files are fine. Test files match common patterns (`test/`, `tests/`,
  `__tests__/`, `spec/`, `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`,
  `*Test.java`, `*Tests.cs`); set `testPaths` in `leanloop.json` to your own globs.
- The checks or `testPaths` in `leanloop.json` changed.
- A check-definition file changed: `package.json` (its scripts and runner
  settings, not name, version, or dependencies), `pyproject.toml` (outside
  `[project]` and `[build-system]`), `Makefile`, `pytest.ini`, `tox.ini`,
  `setup.cfg`, `conftest.py`, `noxfile.py`, Jest, Vitest, Vite, Playwright, AVA,
  Karma, Mocha, c8, and nyc configs, `.npmrc`, `.yarnrc`, `bunfig.toml`, or any
  file a configured check command names (such as `ci/test.sh`). Git-ignored
  definition files are recorded at `start` too.
- A check failed and then passed on the same source: a rerun until green is
  not evidence.
- Test integrity could not be computed (for example, the start-time manifest
  is missing).

If only files outside `--scope` changed, the code is `SCOPE_REVIEW_REQUIRED`.
The comparison uses the commit recorded at `start`, or, in a repository with no
commit yet, a start-time hash manifest. Changes that already existed at `start`
are not charged to the task. The gate cannot see special-casing in source code
or hard-coded results, which the reviewers are told to look for.

Other limits:

- 3 check batches per task by default. Reproducing a failure on the unchanged
  starting source is free twice; later reruns count. When the budget runs out,
  Claude escalates instead of retrying; `extend` needs a stated reason.
- `status` reports `observedFailToPass`: checks that failed earlier in the task
  and pass now, which is the red-then-green evidence for a bug fix.
- Checkpoints store the last check result next to Claude's summary, because a
  summary is a claim.

## Reviewers

- **`leanloop-reviewer`** (Read, Grep, Glob only) checks a finished change
  against its criteria, test integrity, and the recorded evidence. The work
  skill uses it when `finish` requires a review.
- **`leanloop:code-reviewer`** gives a full code review: correctness, security,
  concurrency, compatibility, tests, performance, project rules, plus ML and
  robotics, frontend, and infrastructure add-ons. It verifies each candidate
  before reporting it, drops speculation and style, and may run read-only Git
  and, when allowed, the project's own tests. `/leanloop:review` launches it,
  and swarm mode uses it on the integration diff.

A review is evidence for you, not a guarantee, and its verdict is recorded as
an attestation.

## Project lessons, bounded

`learn` keeps durable facts in `leanloop.lessons.md`, a file you can commit: at
most **30 one-line lessons and 8 KiB**, each with evidence and a date, enforced
on reads too. Near-duplicates are refused. A lesson anchored to a path is
flagged stale when that path disappears. When the file is full, replace or
forget a lesson. In one benchmark, every memory system tested broke some tasks an
agent solved without memory, so lessons are hints to re-check, not facts.

## Audit

`/leanloop:audit` (or `node leanloop.mjs audit`) inventories what Claude Code
loads for the project: CLAUDE.md, `.claude/CLAUDE.md`, and CLAUDE.local.md in the
project and its parent folders (with `@imports`), AGENTS.md files (which Claude
Code reads by default only when no CLAUDE file exists on the path; shadowed ones
are reported), rules, agents, skills, commands, hooks, permissions, and MCP
servers. It flags large always-on text, broad or network-fetching hooks, broad
permissions, unpinned or inline-secret MCP servers, and invisible Unicode. It
never follows symlinks, reads at most 1 MiB per file and 8 MiB in total, and caps
its output at 16 KiB. It exits 1 for high-severity findings or an incomplete
inspection. Findings are structural indicators, not measured tokens or proof of
malicious content.

## Validate the agent

LeanLoop ships a behavior eval suite for Claude Code's `claude plugin eval`.
Six cases plant a trap each: a test that contradicts the specification, an
instruction for AI assistants hidden in an issue, a multi-criteria fix to track,
an unrelated file that invites a rewrite, a read-only question, and three
packages that each need a fix. Graders check files and tool calls; a model
judge grades only the final reply's wording. A post-check script rebuilds each
fixture, compares it with the workspace the agent left, reruns the original
tests against the agent's code (every original test must run and pass, by TAP
count), and checks the LeanLoop ledger against the workspace's own
fingerprint. `npm test` checks the suite itself for free, including on Windows
when Git Bash is on `PATH`; running it against Claude is billed and needs Linux,
macOS, or WSL2. See [Validating agents](docs/agent-validation.md), which also
covers how to validate agents in your own projects.

## What is bounded

| Resource | Behavior |
|---|---|
| Skills and agents | Work skill plus `leanloop-reviewer` at most 8 KiB; code reviewer at most 8 KiB; all skills and agents at most 24 KiB |
| Check attempts | 3 per task by default; an extension needs a recorded reason |
| Check duration | 120 seconds by default per command; configurable up to 3,600 |
| Logs | 64 KiB per stream (head and tail); failed checks return a 1.5 KiB excerpt |
| Continuation state | At most 10 checkpoints, 10 acceptance criteria, 100 check-history entries |
| Project lessons | At most 30 entries and 8 KiB |
| Context fallback | 12 file names by default, at most 30; output at most 8 KiB |
| Repository size | Index listing up to 256 MiB; uncommitted diff up to 64 MiB; untracked content up to 16 MiB |
| Swarm runs | At most 20 packages per plan and 4 workers at once (the 4 is followed by the lead, not enforced) |

## Windows

- Checks run natively. LeanLoop stops a check's whole process tree with
  `taskkill /T` and then removes descendants that outlived it, limited to
  processes created after the check started. Each check costs about half a
  second extra for the process sweep.
- `npm`, `npx`, and other `.cmd` or `.bat` tools run through `cmd.exe`; their
  arguments cannot contain `"`, `%`, `!`, or line breaks, so call the
  underlying executable (for example `node`) if you need them.
- The eval fixtures are bash scripts. `npm test` runs them with Git Bash (or
  WSL's bash) when `bash` is on `PATH`, and skips them otherwise.
- **Native Windows has no Claude Code sandbox**: Claude Code runs shell
  commands there unsandboxed. For untrusted repositories or unattended work,
  including swarm runs, use Claude Code inside WSL2 with its sandbox enabled
  (or Linux or macOS), or a container or VM.

## Failure behavior

- Missing, failed, interrupted, or timed-out checks cannot complete a task.
- Checks that change Git-visible source invalidate their own evidence.
- An active task cannot be overwritten; finish, cancel, or escalate it.
- Concurrent CLI mutations are rejected by a project lock (and a per-run lock
  in swarm mode). After a crash, `status` shows the state and `recover` offers
  explicit modes that never steal a live owner's lock or kill unrelated
  processes.
- No automatic stash, dependency install, or remote operation. Commits, merges,
  and resets happen only inside swarm runs, on the run's own branches and
  worktrees, never on your checked-out branch.

## Security

LeanLoop does not prevent prompt injection. The skills tell Claude to treat
repository files, issues, web pages, tool output, check output, and subagent
reports as data, to stop and quote embedded instructions, and to leave
CLAUDE.md, settings, hooks, and MCP config alone unless asked. In one study,
security rules alone did not lower attack success, so treat these instructions
as a thin layer. Checks run project code with your permissions. Swarm worktrees
isolate files in Git, not processes, reads, or network: a subagent with shell
access can still read sealed tests or edit another worktree, and `swarm accept`
only detects out-of-scope results afterwards. Use Claude Code's sandbox (WSL2,
Linux, or macOS), a container, and network limits for untrusted repositories,
and review changes to configuration, hooks, and dependencies yourself.

## Develop and test

```sh
npm test                    # regression tests, including the eval suite's fixtures and graders
npm run validate            # manifests, frontmatter, budgets, links, hidden Unicode,
                            # and `claude plugin validate --strict` when claude is installed
npm run benchmark           # filename ranking over 100,000 synthetic paths
npm run benchmark:repo      # opt-in: full CLI loop in a 150,000-file Git repo
```

There are no dependencies. Use the [evaluation procedure](docs/evaluation.md) to
compare LeanLoop with your current workflow on your own tasks. Nothing here
claims it is faster, cheaper, or more accurate until you measure that.

Before publishing, keep private words (an employer, internal projects,
hostnames) one per line in a file outside this folder and run
`LEANLOOP_DENYLIST_FILE=/path/outside/terms.txt npm run validate`.

## Read next

- [Design, guarantees, and limits](docs/design.md)
- [Swarm mode guide](docs/swarm.md) and [swarm design](docs/swarm-design.md)
- [Migration from earlier versions](docs/migration.md)
- [Validating agents](docs/agent-validation.md)
- [Evaluation procedure](docs/evaluation.md)
- [Validation record](docs/validation.md)
- [Research and source provenance](SOURCES.md)
- [MIT license](LICENSE)
