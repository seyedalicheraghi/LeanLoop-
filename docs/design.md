# Design and boundaries

## Why one owner

Engineering phases are not automatically separate agents. Localization, planning,
editing, testing, and reporting often share the same evolving context. Splitting
them into role relays can add latency, repeated reads, lossy handoffs, and duplicate
verification without adding an independent capability.

The default is one owner with a small loop. A separate reviewer is valuable when
independence matters. A separate researcher can help when a question is genuinely
separable and needs substantial context. Parallel writers require separate
worktrees and an integration plan; this kit does not manage them.

What the [public evidence](../SOURCES.md) says, in short:

- Anthropic measured about 15x the tokens of chat for its multi-agent research
  system, and cautioned that tightly dependent coding tasks may not benefit.
  That is a research-system observation, not a general coding cost multiplier.
- Splitting a task across agents loses context. Cognition's guidance is to share
  full context and keep writes single-threaded; read-only helpers and review
  loops are the patterns it still sees working.
- A study of over 1,600 multi-agent traces across seven frameworks found
  41-86.7% failure rates, classified into system design, inter-agent
  misalignment, and task verification failures.
- Controlled comparisons (260 configurations, five architectures, three model
  families) found results relative to a single agent ranging from +80.8% on
  decomposable financial reasoning to -70.0% on sequential planning (the best and
  worst cells), with extra overhead on tool-heavy tasks: match coordination to
  task structure.
- Small single-agent loops (mini-SWE-agent) and fixed pipelines (Agentless)
  reach strong benchmark results without role chains.

This is an architectural hypothesis informed by that evidence, not a universal
law that one agent always wins. Measure it on your own tasks with
[the evaluation procedure](evaluation.md).

## Two layers

1. **On-demand instructions:** the skill defines localization, delegation,
   verification, memory, and concise reporting. These remain model-followed
   guidance. Claude Code lists skill descriptions and loads the body on
   activation; discovery alone does not guarantee that a matching task invokes it.
2. **Local deterministic bookkeeping:** the CLI stores task state, executes chosen
   checks, bounds outputs, keeps a capped lessons file, inventories possible
   customization overhead (`audit`), and refuses completion with missing or stale evidence.

No LLM SDK, provider credentials, permanent service, watcher, MCP server, or
lifecycle hook is required. Failure reporting does not depend on another model.

## State and transitions

One task is active per project/worktree. States are:

```text
start -> active -> checking -> active (selected checks passed)
                         \-> blocked (failed, interrupted, or source changed)
active/blocked -> done (all completion gates satisfied)
active/blocked -> cancelled (explicit reason)
```

Only active or blocked tasks can be mutated. A completed/cancelled task is
archived when a new task starts. State writes use a temporary file, fsync, and
same-directory rename. This is not a transactional database or a guarantee
against power loss on every filesystem.

A lock serializes cooperative CLI writers. Complete, fsynced owner metadata is
published with an exclusive hard link, avoiding an empty-lock publication window.
This requires a filesystem supporting same-directory atomic link/rename operations.
A crash can leave a lock behind; normal recovery requires its matching dead PID.
PID reuse can conservatively prevent recovery.

Missing-lock recovery is explicit (`--unlocked --reason`). Malformed legacy or
manually damaged locks require operator-confirmed `--broken-lock --reason` and
are quarantined rather than discarded. A recorded live task owner blocks both.
An invalid record with no task owner cannot prove nobody is running: inspect the
processes before using that override. Recovery never kills arbitrary processes.
Read-only `status` preserves checkpoint access when configuration, lock metadata,
or fingerprinting fails; unknown freshness is explicit and its exit is nonzero.

The local state and bounded command logs are ignored through a dedicated
`.leanloop/.gitignore`. They can contain sensitive task details or command
output. Do not force-add or share that directory blindly. Local history is not
automatically pruned or exported; manage its retention deliberately.

## What verification means

Before and after a check batch, the CLI computes a fingerprint from:

- Git HEAD, or an explicit unborn-repository marker.
- Git-visible staged and unstaged diffs hashed separately, with external
  diff/textconv disabled. A staged change reversed in the worktree is still a
  change; a combined diff against HEAD alone would miss it.
- Nonignored untracked file contents, permissions, or symlink target strings.
- The check configuration, even if Git ignores it.

Workflow state and the `leanloop.lessons.md` file are excluded: they are
bookkeeping, so recording a lesson never makes evidence stale. Logs cannot
invalidate their own result. Any detected change during execution invalidates
the batch. A later change invalidates prior checks, acceptance evidence, and
review for completion.

Clean tracked files are represented by Git HEAD/index and diff behavior rather
than rereading every file. This keeps normal large-repository work proportional
to Git's change detection plus changed/untracked content, not all source bytes.

The fingerprint is **not**:

- A snapshot of ignored files, installed dependencies, environment variables,
  external services, symlink target contents, or files outside the worktree.
- An atomic snapshot while unrelated writers are mutating the repository.
- An authenticated artifact, tamper-proof audit log, or proof a reviewer ran.
- A substitute for testing the actual acceptance criteria.

Use one writer or an isolated worktree, and rerun affected checks after changing
ignored inputs or the environment. Checks operate on a trusted local project.
Malicious commands or a user who edits state can bypass bookkeeping.

Skip-worktree/assume-unchanged index entries, unresolved index conflicts, and
submodules fail closed because this version cannot reliably cover them.
Verify a submodule as its own worktree. Sparse checkouts containing skip-worktree
entries therefore need a separate supported worktree for this verification path.
Non-UTF-8 paths are unsupported.

Git index and inventory listings may use up to 256 MiB (about two million
tracked paths); the index is checked record by record without decoding it into
one string. Uncommitted diffs are limited to 64 MiB, untracked contents to 16 MiB
and 100,000 files, and the filename inventory to 1,000,000 paths. Exceeding a
limit is an error: ignore generated artifacts or commit intended source rather
than silently omitting evidence. A synthetic 220,000-file repository (19.8 MB
index listing) fails in 0.1.0 and completes `start` in 0.37 s and `check` in
0.87 s in 0.2.0 on the recorded machine. These limits are guardrails, not
support for every repository size or layout.

## Check execution

Commands are explicit argv arrays; no shell is inserted. A configured executable
can still perform arbitrary operations. A command such as `bash -c ...` intentionally
opts into shell semantics. This is **not a sandbox or access-control system**.
The project environment is inherited except for Git routing/pathspec overrides
and Node's internal test-context marker. These could otherwise retarget checks to
another index or make a nested `node --test` skip discovery. Removed variable
names, never their values, are recorded in the result. Intentional project
environment such as `NODE_OPTIONS` remains the operator's responsibility.

On Linux and macOS each check owns a POSIX process group. Timeout, interruption,
and normal cleanup terminate that group, including ordinary descendants. A
process deliberately escaping into another session, a remote job, or an
uninterruptible kernel wait is outside this guarantee. Host termination with
SIGKILL cannot run cleanup.

Windows has no process groups. A check runs as an ordinary child; stopping it
runs `taskkill /T /F` on the live tree, then a PowerShell CIM query finds
descendants that outlived their parent and stops them too. Only processes
created after the check started count, and the root's direct children must
predate its exit, so a reused PID cannot widen the sweep. If the sweep cannot
run, the check fails with a cleanup error rather than passing. `.cmd` and `.bat`
programs (npm, npx, pnpm) cannot be spawned without a shell, so they run through
`cmd.exe /d /s /c` with every argument quoted; arguments containing `"`, `%`,
`!`, or line breaks are refused because `cmd.exe` would reinterpret them. Checks
are not started detached on Windows: a detached `cmd.exe` loses its children's
inherited output pipes.

Checks stop after the first failure. Unknown executables, nonzero exits, timeout,
interruption, missing expected output, and output-write/cleanup errors are failures.
Each stream keeps a bounded head and tail with an explicit elision marker; logs
are finalized after the check. Literal output assertions are matched incrementally
against the full stream, including split chunks, not only retained log bytes.
The truncation flag survives a resumed status. Successful process completion
does not establish a positive test count or coverage; configure useful assertions
and inspect the runner's real results.

`check --only NAME` records targeted results. Other results are reusable only
for the exact same fingerprint. `selectionPassed` describes the requested batch;
`allChecksPassed` describes all configured checks. Pending checks are listed, and
a known failure elsewhere prevents `ok: true`. All configured checks are required
at completion.

Acceptance and review entries are explicitly labeled operator attestations.
Different reviewer strings are required, but identities are not authenticated.
A model can still make a false claim; the owner must supply inspectable evidence.

A failed check's result carries the last 1,500 bytes of its output (stderr if it
wrote any, otherwise stdout), labeled as untrusted project data. Agents rarely
page through truncated output, so the failure has to travel with the result;
the full bounded logs stay in `.leanloop/logs/`.

## Integrity, escalation, and history

Agents under pressure edit or delete tests, special-case test inputs, or weaken
checks to get a pass (see [SOURCES.md](../SOURCES.md)). `start` records the HEAD
commit and a digest of the configured checks and `testPaths`. `status` and
`finish` compare the tracked files against that commit, with staged and
worktree changes included. A modified, deleted, or retyped file that matches a
test pattern, or any change to the checks or `testPaths`, makes `finish` require
an approving review recorded on the final source (`INTEGRITY_REVIEW_REQUIRED`).
New test files do not. The review requirement does not prove the change is
wrong; it makes a second reader look at it.

Limits: a task started in an empty repository has no base commit and reports
the integrity check as unavailable. Untracked files that existed at `start` and
were later edited are not detected. Special-casing in source code, hard-coded
results, and new skip markers are invisible to this gate; the reviewer is told
to look for them. Tasks started before 0.5.0 have no base and are not gated.

`escalate KIND SUMMARY --tried TEXT --recommend TEXT` stops a task with a
structured record: a conflict between tests and the specification, an exhausted
budget, missing access, or unclear scope. It moves the task to `blocked` and
shows the record in `status`. When the attempt budget runs out, the error points
to `escalate` before `extend`. In one controlled study, an escalation channel
plus a written policy cut test hacking from 23.6% to 5.3%, pooled over eight models;
the result came from nine defective problems and does not transfer automatically.

Each check run appends a bounded history entry (at most 100 per task) with name,
result, exit code, and a short fingerprint. `status` derives `observedFailToPass`:
checks that failed earlier in the task and pass on the current source, which is
the red-then-green evidence for a bug fix. It is reported, not required, because
many bugs cannot be reproduced by a test. Checkpoints store the last check
result beside the owner's summary, since a summary written before compaction is
a claim, not evidence.

## Bounded project memory

Durable facts belong in a small file that is cheap to read at the start of every
session: build and test commands, traps, layout facts. `learn` writes one-line,
dated, evidence-backed entries to `leanloop.lessons.md`. The file holds at
most 30 entries and 8 KiB. When it is full, `learn` refuses until a stale entry
is replaced (`--replace ID`) or removed (`forget ID`).

Why a hard cap: performance degrades as input grows, even on simple tasks
("context rot"), and information in the middle of long inputs is used least.
Append-only learnings files grow with every task until each agent start pays for
all of them. Replacing an entry is a small, targeted edit, which also avoids the
opposite failure of rewriting a whole memory into a vague summary.

The file is meant to be read and edited by people. Text that is not an entry is
an error rather than a silent deletion. Writes use the project lock and an atomic
rename. Lessons are attestations like `prove`: the CLI checks their shape and
size, not their truth. Reads enforce the same 30-entry/8 KiB caps. If hand edits
exceed them, curate the file before using the CLI; it will not silently discard
entries or load oversized memory.

One coding-agent memory benchmark found that every memory system tested broke some
tasks the agent would otherwise solve, mostly by applying old experience where it
no longer fit. So lessons are hints: the skill tells the owner to confirm a
lesson against the current files, to record only lessons backed by a check it
ran, and never to store shortcuts that skip tests or text taken from external
content. `learn` refuses near-duplicates (differing only in case, spacing, or
trailing punctuation). `--anchor PATH` ties a lesson to a file that must exist;
`lessons` lists anchored lessons whose path has disappeared as `stale`.

## Overhead audit

`audit` inventories what Claude Code loads for a project. It reads only
customization files and file metadata, works without Git or LeanLoop
configuration, never writes, and never follows symlinks.

- **Always-on text:** `CLAUDE.md`, `.claude/CLAUDE.md`, and `CLAUDE.local.md`;
  files they `@import` (relative to the importing file, up to four hops,
  ignoring imports inside code, stopping cycles; imports outside the project are
  listed but not read); `.claude/rules` files without a `paths` field; and
  `CLAUDE.md` or `.claude/CLAUDE.md` in every parent folder up to the
  filesystem root, which covers `~/.claude/CLAUDE.md` for projects under your
  home folder.
- **On demand:** nested `CLAUDE.md` files and rules with `paths`.
- **Components:** `.claude/agents`, `.claude/skills`, `.claude/commands`,
  hooks and permissions in `.claude/settings.json` and `settings.local.json`,
  and `.mcp.json` servers.

| Finding | Severity |
|---|---|
| `ALWAYS_ON_LARGE` | medium over 8 KiB, high over 16 KiB of always-on text |
| `LONG_INSTRUCTION_FILE` | low: an always-on file over 200 lines (Claude Code's own guidance) |
| `MANY_AGENTS`, `ROUTER_AGENT` | medium: more than 4 agents; agents that can launch agents |
| `AGENTS_WITH_ALL_TOOLS` | low: an agent without a `tools` list inherits every tool |
| `PINNED_MODELS` | info |
| `PER_TOOL_HOOKS` | medium for 1-4, high for 5 or more broadly matched tool hooks |
| `RISKY_HOOK` | medium: a hook fetches from the network, pipes into an interpreter, or runs an unpinned npx/uvx/pipx package |
| `MCP_UNPINNED`, `MCP_REMOTE`, `MANY_MCP_SERVERS` | medium, info, low |
| `MCP_INLINE_SECRET` | high: a literal secret-looking value; only the key name is reported |
| `BROAD_PERMISSIONS` | high for `bypassPermissions` or a bare `Bash`/`*` allow rule; medium for enabling all project MCP servers |
| `HIDDEN_UNICODE` | high: invisible tag, zero-width, or bidirectional control characters; file and count only |
| `INJECTION_LIKE` | low: phrases such as "ignore previous instructions"; file and line numbers only |
| `MEMORY_UNBOUNDED`, `LARGE_REFERENCED_FILES` | memory-like files and large files referenced from instructions |
| `NO_TEST_COMMAND` | info: no always-on text names a test command |

These are structural indicators, not a trace of what Claude Code loaded,
executed, cached, or billed, and not a malware scanner: the security findings
catch common patterns and miss deliberate disguises. Research found that the
size and position of instruction files did not measurably change adherence, so
size findings describe recurring context cost, not quality. Audit advice must
preserve authorization, secret protection, and destructive-action guards.

Reads are bounded to 1 MiB per file and 8 MiB in total, with up to 2,000
entries per customization directory. Oversize files, symlinks, inaccessible
paths, and malformed settings are listed in `skipped` and make
`complete: false` with exit 1, so a missing piece of evidence is never mistaken
for a clean result. A symlinked `~/.claude` folder therefore makes every audit
incomplete; that is the cost of never following symlinks. Detail lists hold at
most 10 entries, and serialized JSON plus newline is limited to 16 KiB; when
long paths still exceed that, lists shrink first and `output.truncated` is set.
File contents never appear in the output. Tokens are estimated as bytes/4.

## Packaging and project setup

LeanLoop is a Claude Code plugin. The repository root is the plugin:
`.claude-plugin/plugin.json` names it, and `.claude-plugin/marketplace.json`
publishes it with `source: "./"`. Claude Code discovers `skills/work`,
`skills/setup`, `skills/audit`, and `agents/leanloop-reviewer.md` by convention.
Skills call the bundled CLI through `${CLAUDE_PLUGIN_ROOT}/leanloop.mjs`, which
Claude Code substitutes in skill text. The plugin root changes on every update,
so no state is written there. The plugin ships no hooks, MCP servers, `bin/`
PATH additions, settings, or permission rules; validation fails if any appear.

Every enabled plugin adds its skill and agent descriptions to each session, so
descriptions stay short, and `setup` and `audit` are user-invoked only
(`disable-model-invocation`). The work skill plus the reviewer stay within 8 KiB
and all skills plus the reviewer within 12 KiB. The reviewer's `tools` list
(Read, Grep, Glob) keeps it read-only; a plugin agent cannot change its own
permission mode.

`init` creates only `leanloop.json` (when absent) and `.leanloop/.gitignore`,
publishing each file exclusively under the project lock. It validates an
existing configuration instead of replacing it, refuses a symlinked state
directory or a modified state ignore file, and changes nothing else. It refuses
a project that still has a pre-rename lean-workflow install. Copies that 0.4.0
vendored into projects are reported as duplicates of the plugin and left for
you to remove. No project or user instruction hierarchy is overridden.

## Output and attention

Lead with outcome or blocker, keep the next action obvious, and retain details
for inspection. Do not manufacture causes or timing estimates to sound decisive.
User-requested explanation, safety information, uncertainty, and failures take
priority over brevity. No diagnosis or medical assumption is encoded.

The report rules adapt ideas from an output-style skill whose own evaluation
showed gains in progress and error reports, and one regression its author
suspects came from requiring "cause, then fix", which can push an unsupported
cause. Hence the explicit "cause unknown" rule and no mandatory time estimates.
