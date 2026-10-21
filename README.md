# LeanLoop

**One owner. Small context. Evidence before "done".**

LeanLoop is a Claude Code plugin. It gives Claude one working method for code
changes and a small local CLI that refuses to call a task done until checks
passed on the current source, every acceptance criterion has evidence, and any
edited test or check has been reviewed. It ships three skills, one read-only
reviewer agent, and the CLI. It adds no hooks, MCP servers, model calls,
telemetry, dependencies, or background processes. Claude still does the work.

It replaces role-chained multi-agent setups (planner → coder → tester →
reviewer → reporter) with one owner that keeps the task in one context, verifies
with real commands, and keeps memory bounded. The [design](docs/design.md) and
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
papers on coding agents, listed with their effect on the design in
[SOURCES.md](SOURCES.md).

## Install

Requirements: Claude Code, Node 22+ on `PATH`, and Git. Linux, macOS, and
Windows are supported.

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

The plugin adds a short description of each skill and the reviewer to Claude's
context in every session. The skill bodies load only when used.

## Use it in a project

1. **Set up once:** run `/leanloop:setup` in the project. It creates
   `leanloop.json` and an ignored `.leanloop/` folder, suggests checks from the
   project's own scripts, and records only the ones you approve.
2. **Work:** ask for a change as usual, or start with `/leanloop:work fix the
   pagination bug`. Claude follows the loop below for larger changes and keeps
   small ones small.
3. **Audit:** `/leanloop:audit` inventories the project's Claude Code setup for
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
review --by ID --decision approve|request-changes --evidence TEXT
finish                  succeeds only when every gate below holds
checkpoint SUMMARY --next ACTION
learn LESSON --evidence TEXT [--anchor PATH] / forget ID
```

`prove` and `review` record attestations. The CLI cannot authenticate who wrote
them or whether they are true.

## What "done" requires

`finish` refuses unless all of these hold for the current source fingerprint
(commit, staged changes, worktree changes, untracked files, and `leanloop.json`):

| Gate | Why |
|---|---|
| Every configured check passed on this exact source | Any later edit makes old results stale |
| Every acceptance criterion has evidence recorded on this source | A green build is not the requested behavior |
| High-risk tasks have an approving independent review | Fresh-context review of risky changes |
| **Edited or deleted test files, or changed checks, have an approving review** | Agents under pressure edit tests to pass; additions are fine |

The integrity gate compares tracked files against the commit recorded at
`start`. Test files match common patterns (`test/`, `tests/`, `__tests__/`,
`spec/`, `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`, `*Test.java`,
`*Tests.cs`); set `testPaths` in `leanloop.json` to your own globs. It cannot see
special-casing in source code or hard-coded results, which the reviewer is told
to look for.

Other limits:

- 3 check batches per task by default. When they run out, Claude escalates
  instead of retrying; `extend` needs a stated reason.
- `status` reports `observedFailToPass`: checks that failed earlier in the task
  and pass now, which is the red-then-green evidence for a bug fix.
- Checkpoints store the last check result next to Claude's summary, because a
  summary is a claim.

## Project lessons, bounded

`learn` keeps durable facts in `leanloop.lessons.md`, a file you can commit: at
most **30 one-line lessons and 8 KiB**, each with evidence and a date, enforced
on reads too. Near-duplicates are refused. A lesson anchored to a path is
flagged stale when that path disappears. When the file is full, replace or
forget a lesson. Research found memory systems often break tasks an agent would
otherwise solve, so lessons are treated as hints to re-check, not facts.

## Audit

`/leanloop:audit` (or `node leanloop.mjs audit`) inventories what Claude Code
loads for the project: CLAUDE.md files (including those in parent folders and
`@imports`), rules, agents, skills, commands, hooks, permissions, and MCP
servers. It flags large always-on text, broad or network-fetching hooks, broad
permissions, unpinned or inline-secret MCP servers, and invisible Unicode. It
never follows symlinks, reads at most 1 MiB per file and 8 MiB in total, and caps
its output at 16 KiB. It exits 1 for high-severity findings or an incomplete
inspection. Findings are structural indicators, not measured tokens or proof of
malicious content.

## What is bounded

| Resource | Behavior |
|---|---|
| Skills and reviewer | Work skill plus reviewer at most 8 KiB; all skills plus reviewer at most 12 KiB |
| Check attempts | 3 per task by default; an extension needs a recorded reason |
| Check duration | 120 seconds by default per command; configurable up to 3,600 |
| Logs | 64 KiB per stream (head and tail); failed checks return a 1.5 KiB excerpt |
| Continuation state | At most 10 checkpoints, 10 acceptance criteria, 100 check-history entries |
| Project lessons | At most 30 entries and 8 KiB |
| Context fallback | 12 file names by default, at most 30; output at most 8 KiB |
| Repository size | Index listing up to 256 MiB; uncommitted diff up to 64 MiB; untracked content up to 16 MiB |

## Windows

Checks run natively. LeanLoop stops a check's whole process tree with
`taskkill /T` and then removes descendants that outlived it, limited to
processes created after the check started. `npm`, `npx`, and other `.cmd` or
`.bat` tools run through `cmd.exe`; their arguments cannot contain `"`, `%`, `!`,
or line breaks, so call the underlying executable (for example `node`) if you
need them. Each check costs about half a second extra for the process sweep.

## Failure behavior

- Missing, failed, interrupted, or timed-out checks cannot complete a task.
- Checks that change Git-visible source invalidate their own evidence.
- An active task cannot be overwritten; finish, cancel, or escalate it.
- Concurrent CLI mutations are rejected by a project lock. After a crash,
  `status` shows the state and `recover` offers explicit modes that never steal
  a live owner's lock or kill unrelated processes.
- No automatic stash, commit, reset, dependency install, or remote operation.

## Security

LeanLoop does not prevent prompt injection. The work skill tells Claude to treat
repository files, issues, web pages, tool output, and check output as data, to
stop and quote embedded instructions, and to leave CLAUDE.md, settings, hooks,
and MCP config alone unless asked. Research shows instructions like these lower
but do not remove the risk. Checks run project code with your permissions. Use a
container or OS sandbox and network limits for untrusted repositories, and
review changes to configuration, hooks, and dependencies yourself.

## Develop and test

```sh
npm test                    # regression tests on synthetic temporary Git projects
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
- [Migration from earlier versions](docs/migration.md)
- [Evaluation procedure](docs/evaluation.md)
- [Validation record](docs/validation.md)
- [Research and source provenance](SOURCES.md)
- [MIT license](LICENSE)
