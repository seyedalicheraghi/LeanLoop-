# LeanLoop

**One engineering owner. Small context. Evidence before "done".**

A small, independently written workflow kit for AI coding agents: GitHub Copilot
(VS Code, CLI, cloud agent), OpenAI Codex, Gemini CLI, and Claude Code. It installs
one on-demand skill, an optional read-only reviewer, and a local Node CLI. It adds
no model calls, API client, server, runtime dependencies, telemetry, or hooks.
Your existing agent still does the engineering.

It replaces role-chained multi-agent setups (planner → coder → tester → reviewer →
reporter) with one owner that keeps the whole task in one context, verifies with
real commands, and keeps memory bounded. See [design](docs/design.md) for the
evidence behind that choice.

This is a workflow and evidence tool, not a replacement agent, sandbox, automated
review service, or promise of cheaper or correct results. It is original,
general-purpose code: no private project implementation or employer branding is
included. Package contents and licensing do not by themselves determine legal
ownership of work.

LeanLoop was called lean-workflow until 0.4.0. To move an existing install, see
[Moving from lean-workflow](docs/migration.md#moving-from-lean-workflow).

## Based on

LeanLoop is based on two public projects:

- **[ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd)** (MIT), a skill
  that stops coding agents from burying the answer. LeanLoop's reporting style
  comes from it: outcome first, numbered steps, one next action, short lists.
  It also showed that one skill folder (`.agents/skills/`) can serve many hosts.
- **[WorldFlowAI/everything-claude-code](https://github.com/worldflowai/everything-claude-code)**,
  a Claude Code toolkit of agents, commands, skills, rules, and hooks, which builds
  on [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)
  (MIT). LeanLoop keeps the ideas behind its reusable skills and its verify,
  checkpoint, and learn workflows, as bounded local commands. It leaves out the
  role agents, broad hooks, and memory that only grows.

LeanLoop is an independent implementation: no code, prompts, or skill text were
copied from either project, and their licenses cover their own work. See
[SOURCES.md](SOURCES.md) for every reference and what was not adopted.

## Start in an existing project

Requirements: Node 22+, Git, and a Git worktree root. Verification uses POSIX
process groups and supports Linux/macOS; this release does not support Windows
verification. Windows and macOS have not been exercised by the Linux test run.

Get the source once:

```sh
git clone https://github.com/seyedalicheraghi/LeanLoop-.git "$HOME/src/leanloop"
```

From the **project you want to work on**, preview and apply the installation:

```sh
node "$HOME/src/leanloop/bin/leanloop.mjs" init --project "$PWD" --dry-run
node "$HOME/src/leanloop/bin/leanloop.mjs" init --project "$PWD"
```

Pick where the skill goes with `--host` (repeatable):

| Host | Skill folder | Reviewer | Read by |
|---|---|---|---|
| `portable` (default) | `.agents/skills/leanloop/` | `.github/agents/leanloop-reviewer.agent.md` | Copilot (VS Code, CLI, cloud), Codex, Gemini CLI |
| `copilot` | `.github/skills/leanloop/` | `.github/agents/leanloop-reviewer.agent.md` | Copilot only (the 0.1.0 layout) |
| `claude` | `.claude/skills/leanloop/` | `.claude/agents/leanloop-reviewer.md` | Claude Code (and VS Code) |

Use one of `portable` or `copilot`, not both; add `claude` if you use Claude Code.
The installer also adds a project-owned `leanloop.json` check configuration
and an ignored `.leanloop/` state directory.

It does not overwrite customizations, change existing instructions, select
models, register plugins, create commits, install dependencies, or start checks.
An identical reinstall is a no-op. A conflicting file is an error, not permission
to replace it. The copied runtime continues to work without this source package.
An installation registry records shipped-file digests and hosts. For a later
release, preview `init --upgrade --dry-run`, then use `init --upgrade`; the hosts
you installed are kept. Only registered, unmodified files can be replaced or
retired; local edits remain conflicts. To move a 0.1.0 install to the portable
location, run `init --upgrade --host portable`.

### Configure the checks you actually need

The initial configuration intentionally has **no checks**. `doctor` suggests
commands it detects (npm/pnpm/yarn/bun scripts, pytest, cargo, go, make, Bazel) but
never records them. It honors `packageManager`, then unambiguous lockfiles, and
reports malformed files instead of silently guessing. Review a suggestion,
including any target placeholder, then record only what matters:

```sh
node .agents/skills/leanloop/scripts/workflow.mjs doctor
node .agents/skills/leanloop/scripts/workflow.mjs add-check test --timeout 120 -- npm test
```

Do not add every possible check to every project. In a large Bazel or monorepo
project, point a check at the affected targets, never `//...` by default. Review
each command before running it: checks execute with your account's permissions
and inherited environment.

Commands are argument arrays, not shell strings. To use a shell intentionally,
configure that shell explicitly and review its arguments. Never put credentials
in the committed configuration.

An optional literal `--expect-output "specific success marker"` prevents a
zero-exit command without that marker from passing. This is not a universal
test-discovery parser; inspect test counts and test behavior yourself.

To change or remove a configured check, edit `leanloop.json` explicitly.
Unknown fields, duplicate names, invalid paths, and invalid timeouts are errors.

### Activate

- **VS Code (Copilot):** open **Chat: Open Customizations → Skills** and confirm
  `leanloop` is listed. The skill is eligible for automatic selection on
  code tasks; discovery does not guarantee invocation. Use `/leanloop` to
  request it explicitly and verify activation in the host.
- **Codex and Gemini CLI:** they discover `.agents/skills/` at session start.
  Gemini asks for consent before it activates a skill.
- **Claude Code:** install with `--host claude`, then use `/leanloop`.

To make the skill explicit-only, add `disable-model-invocation: true` to its
frontmatter (VS Code and Claude Code honor it). Use `leanloop-reviewer` only for a
justified independent review: it has read/search tools only and cannot run tests
or edit files.

**Existing policies still apply.** If a project mandates another orchestrator or
a long role chain, resolve that conflict deliberately before adoption. Run
`audit` first and see [migration](docs/migration.md). Adding this kit underneath
conflicting rules does not remove their overhead.

## Find what makes a setup slow: `audit`

`audit` is read-only and works in any project, with or without this kit:

```sh
node "$HOME/src/leanloop/bin/leanloop.mjs" audit --project /path/to/project
```

It inventories project-local files and suggests what to investigate. It does not
observe model requests, cached tokens, actual hook executions, or user-level
configuration. Host-specific files are reported together, not assumed to load
into every agent:

| Finding | What it measures |
|---|---|
| `ALWAYS_ON_LARGE` | Bytes of potential root instructions across hosts |
| `ROLE_CHAIN` / `MANY_AGENTS` | Declared agents and possible handoff paths within each host directory |
| `ROUTER_AGENT` | Agents declaring delegation tools; not necessarily routing-only agents |
| `PINNED_MODELS` | Explicit model declarations, not measured costs |
| `PER_TOOL_HOOKS` | Command hooks configured with broad tool-event matchers |
| `MEMORY_UNBOUNDED` | Size of memory-like files, not proof they are loaded |
| `LARGE_REFERENCED_FILES` | Large documents mentioned in instructions, not proof of full reads |
| `MANY_MCP_SERVERS` | Configured servers; actual tool discovery may be deferred |

Exit status is 1 for high-severity findings **or incomplete inspection**.
`complete`, `skippedCount`, `skipped`, and inventory/graph truncation fields make
missing evidence explicit. Serialized output is capped at **16 KiB**, including
the newline; `output.truncated` means detail lists were shortened, not that the
remaining entries constitute the whole inventory. Counts remain available.
Thresholds and bytes/4 token estimates are heuristics, not provider limits or
billed usage. Keep safety hooks: measure and optimize redundant bookkeeping
without removing authorization or destructive-action protections.

## The working loop

For substantial code changes, the owner uses these operations while doing the
actual edits and tests with the host's ordinary tools:

```sh
W=".agents/skills/leanloop/scripts/workflow.mjs"
node $W status                      # resume: task state and next action
node $W lessons                     # project lessons, at most 30

# Establish an observable outcome, not a list of job titles.
node $W start "Reject invalid pagination limits" \
  --accept "Negative limits return the documented validation error" \
  --accept "Valid pagination remains unchanged" --scope src --scope tests

# Prefer editor symbols/references. This fallback returns paths, not source text.
node $W context "pagination limit"

# After implementing the change and regression tests:
node $W check --only test           # an example name configured above
# Run check for any remaining required checks on the final source.
# Do not repeat an identical batch when allChecksPassed is already true.
node $W prove 1 "Regression test negative-limit passed; its pre-fix failure was observed."
node $W prove 2 "Existing valid-pagination tests passed with unchanged response assertions."
node $W finish
node $W learn "Pagination tests live in tests/api/pagination.test.mjs." --evidence "found via context"
```

These evidence strings are examples, **not results to paste without verification**.
`prove` and `review` record operator attestations; the CLI cannot authenticate
the author, inspect a remote agent, or determine whether a statement is true.

Use `status` to resume, and `checkpoint SUMMARY --next ACTION` at meaningful
boundaries. The state survives a new chat, process, or compaction. It is not
automatic conversation memory: the owner must write an accurate checkpoint.

For high-risk changes, pass `--risk high` when starting. Before finishing:

```sh
node $W review --by independent-reviewer --decision approve \
  --evidence "Final change and acceptance tests reviewed; no unresolved findings."
```

A review requesting changes blocks completion even for a normal-risk task.
Any Git-visible source change, including a staging-only change, makes previous
checks, acceptance evidence, and review stale. Rerun checks for the final source
and obtain updated evidence rather than
relabeling old results. Editing `leanloop.lessons.md` does not.

## Project lessons, bounded

`learn` keeps durable facts (commands, traps, layout) in `leanloop.lessons.md`,
a readable file you can commit. Each lesson is one line with evidence and a date.
The file holds at most **30 lessons and 8 KiB**, on reads as well as writes;
manual edits cannot bypass these budgets. When it is full, `learn` refuses
until you `forget ID` or `learn ... --replace ID`. Hand-written text in the file is
never dropped: a line that is not an entry is an error, not a silent deletion.
This replaces append-only learnings files that every agent must read in full.

## What is bounded

| Resource | Behavior |
|---|---|
| Default architecture | One delivery owner; review or helpers only when justified |
| Customization text | One skill and one reviewer, combined at most 8 KiB |
| Audit | 1 MiB per customization, 8 MiB total text; serialized output at most 16 KiB |
| Project lessons | At most 30 entries and 8 KiB |
| Context fallback | 12 filenames by default; at most 30; actual JSON output at most 8 KiB |
| Repository size | Index listing up to 256 MiB (about 2 million tracked paths); filename inventory up to 1,000,000 paths |
| Uncommitted diff | Up to 64 MiB; untracked file contents up to 16 MiB and 100,000 files |
| Check attempts | 3 per task by default; an extension needs a recorded reason |
| Check duration | 120 seconds by default per command; configurable up to 3,600 |
| Logs | 64 KiB per stream, retaining head and tail; assertions examine the full stream |
| Continuation state | At most 10 checkpoints and 10 acceptance criteria |

The host owns model calls, tool calls, tokens, and billing. The skill's delegation
guidance is **advisory**, not an enforced provider budget. Check-attempt limits are
enforced only for checks run through this CLI.

The filename fallback is deliberately not a semantic repository map. It does
not replace LSP, dependency analysis, search, or reading relevant consumers.

## Failure behavior

- Missing, failed, interrupted, or timed-out checks cannot complete a task.
- Unknown check names and an empty check configuration are errors.
- Checks that change Git-visible source invalidate their own evidence.
- All configured checks must pass for the final source; a targeted check alone
  cannot substitute for missing required checks.
- Targeted results report `selectionPassed`, `allChecksPassed`, `knownFailing`,
  and `pendingChecks`. A carried-over failure keeps the task blocked.
- An active task cannot be overwritten. Finish or cancel it with a reason.
- Concurrent CLI mutations are rejected by a project lock.
- After an abnormal crash, inspect `status`. `recover --owner-pid PID` refuses
  a live or mismatched owner. With a missing lock, `recover --unlocked --reason TEXT`
  can reset stranded state. An invalid lock requires operator-confirmed
  `recover --broken-lock --reason TEXT`, which quarantines it. Neither mode can
  displace a recorded live task owner. Inspect orphaned check processes yourself.
- If freshness cannot be computed, `status` still returns the checkpoint and
  explicit diagnostics, with unknown freshness and a nonzero exit status.
- No automatic stash, commit, reset, dependency install, or remote operation occurs.

See [the full contract and limitations](docs/design.md).

## Test, measure, distribute

From this package:

```sh
npm test                    # regression tests on synthetic temporary Git projects
npm run validate            # syntax, links, manifests, frontmatter, size budget
npm run benchmark           # filename ranking over 100,000 synthetic paths
npm run benchmark:repo      # opt-in: full CLI loop in a 150,000-file Git repo
npm pack --ignore-scripts --pack-destination /path/to/output
```

There are no dependencies to install. The tests use synthetic temporary Git
projects, not an existing codebase or real model API.

Before publishing, you can prove that private words (an employer, internal
projects, hostnames) are absent without writing them into the package: keep them
one per line in a file **outside** this folder and run
`LEANLOOP_DENYLIST_FILE=/path/outside/terms.txt npm run validate`.

The package is marked private to prevent accidental registry publishing, but it
can be packed and installed from its local archive:

```sh
npm install --global --ignore-scripts /path/to/leanloop-kit-0.4.0.tgz
leanloop init --project /path/to/project --dry-run
```

Alternatively, keep the extracted folder and invoke its CLI with Node. A legacy
Copilot [plugin manifest](plugin.json) is included for manual plugin loading.
Native plugin loading supplies the skill/reviewer; it does **not** initialize
project configuration. Run `init` separately if you want the local task runtime.

Use [controlled evaluation](docs/evaluation.md) to measure actual success,
wall-clock time, tokens, and cost against your existing workflow. The synthetic
benchmarks measure CLI bookkeeping only; they are not evidence of coding quality
or API savings.

## Read next

- [Design, guarantees, and limits](docs/design.md)
- [Adopting it without breaking existing policy](docs/migration.md)
- [Evaluation and cross-provider review](docs/evaluation.md)
- [Recorded validation and remaining limits](docs/validation.md)
- [Research and source provenance](SOURCES.md)
- [MIT license](LICENSE)
