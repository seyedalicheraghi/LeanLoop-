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
- A study of over 1,600 multi-agent traces found 41-86.7% failure rates, mostly
  from system design and inter-agent misalignment, not model limits.
- Controlled comparisons (260 configurations, five architectures, three model
  families) found results relative to a single agent ranging from +80.8% on
  decomposable financial reasoning to -70.0% on sequential planning, with extra
  overhead on tool-heavy tasks: match coordination to task structure.
- Small single-agent loops (mini-SWE-agent) and fixed pipelines (Agentless)
  reach strong benchmark results without role chains.

This is an architectural hypothesis informed by that evidence, not a universal
law that one agent always wins. Measure it on your own tasks with
[the evaluation procedure](evaluation.md).

## Two layers

1. **On-demand instructions:** the skill defines localization, delegation,
   verification, memory, and concise reporting. These remain model-followed
   guidance. Supported hosts discover skill metadata and load the body on
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

Each check owns a POSIX process group. Timeout, interruption, and normal cleanup
terminate that group, including ordinary descendants. A process deliberately
escaping into another session, a remote job, or an uninterruptible kernel wait
is outside this guarantee. Host termination with SIGKILL cannot run cleanup.
Windows process-tree behavior is unsupported.

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

## Bounded project memory

Durable facts belong in a small file that is cheap to read at the start of every
session: build and test commands, traps, layout facts. `learn` writes one-line,
dated, evidence-backed entries to `leanloop.lessons.md`. The file holds at
most 30 entries and 8 KiB. When it is full, `learn` refuses until a stale entry
is replaced (`--replace ID`) or removed (`forget ID`).

Why a hard cap: accuracy drops as input grows, well before context limits
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

## Overhead audit

`audit` reads only customization files and file metadata, works without Git or
this kit's configuration, never writes, and never follows symlinks. It reports:
potential root-instruction bytes; custom agents, their declared handoff graph,
delegation tools, and model choices; broadly matched command hooks; MCP servers;
memory-like files (learnings, lessons, ledgers, journals, session logs); and files
over 32 KiB mentioned in instructions. These are structural indicators, not a
trace of what a host loaded, executed, cached, or billed. A delegation-capable
agent is not necessarily a router; a mentioned file need not be read in full.
User-level and inherited host settings are outside the audit's scope.

Customization reads are bounded to 1 MiB per file and 8 MiB total, with up to
2,000 entries per customization directory. Inventory stops at 300,000 paths
(filesystem fallback counts directory entries too); nested guide metadata is
sampled up to 5,000 with explicit totals/truncation. Oversize files, inaccessible
or symlinked managed paths, and malformed settings are reported in `skipped`.
Git failures are not silently converted into a filesystem scan; non-Git and
nested directories use an explicitly labelled filesystem inventory.

`complete: false` and a nonzero exit expose incomplete inspection, even with no
high-severity findings. Frontmatter/TOML handling recognizes simple declarations;
it is not a full host configuration validator. JSONC is reported as unparsed.
Most detail lists have at most 10 entries, and serialized JSON plus newline is
limited to 16 KiB. When long paths still exceed that bound, detail lists shrink
and `output.truncated` is true; counts, findings, and completeness remain visible.
Names retain their exact identity during counting/graph analysis and are shortened
only for display. Same-named agents in different discovery directories do not
silently replace each other.

Thresholds are heuristics chosen from the evidence above, not provider limits:
always-on text over 8 KiB is medium and over 16 KiB high; a handoff chain of 3
agents is medium and of 4 or more high; 1-4 per-tool hook commands are medium and
5 or more high; memory over 32 KiB is medium and over 128 KiB high. Tokens are
estimated as bytes/4. The longest declared handoff path is a bounded, iterative
search over simple paths; `chainExact: false` marks a capped search. Neither a
declared path nor a high heuristic severity proves wasted time. Audit advice
must preserve authorization, secret protection, and destructive-action guards.

## Installation and update contract

Hosts decide where the skill and reviewer go. `portable` (the default) installs
the skill in `.agents/skills/`, which Copilot (VS Code, CLI, cloud agent), Codex,
and Gemini CLI discover, plus the Copilot reviewer in `.github/agents/`. `copilot`
keeps the 0.1.0 layout in `.github/skills/`. `claude` installs `.claude/skills/`
and a Claude-format reviewer in `.claude/agents/`, generated from the same source
by rewriting only its tools line. The registry records the chosen hosts; a later
`init` without `--host` keeps them, and a 0.1.0 registry without hosts is treated
as `copilot`. Changing hosts retires the old files, so it needs `--upgrade`, and
only unmodified files move. Empty folders left inside a retired skill folder are
removed after a successful upgrade.

The installer preflights all managed paths, refuses symlinked destinations and
conflicting contents, and publishes complete new files exclusively. Reinstallation
preserves an existing valid check configuration. The install registry records
digests only for owned assets, not project configuration. Explicit `--upgrade`
can replace or retire a registered file only if its contents still match its
recorded digest. Modified assets block the whole preflight. Unrelated files are
never rewritten. Failed writes attempt to restore this attempt's changes, report
rollback errors, and may leave empty directories.

The installer is not hardened against a hostile process changing filesystem paths
concurrently. Run it in a trusted project without concurrent customization edits.
It does not merge user edits automatically. Preview upgrades, then back up,
compare, and reconcile conflicts deliberately. No registry means no automatic
claim of ownership over different existing contents.

No project or user instruction hierarchy is overridden. A plugin manifest is
packaging, not proof that every client loads all components. Test discovery in the
selected host; file-based installation is the primary supported path.

## Output and attention

Lead with outcome or blocker, keep the next action obvious, and retain details
for inspection. Do not manufacture causes or timing estimates to sound decisive.
User-requested explanation, safety information, uncertainty, and failures take
priority over brevity. No diagnosis or medical assumption is encoded.

The report rules adapt ideas from an output-style skill whose own evaluation
showed gains in progress and error reports, and one regression where requiring
"cause, then fix" pushed the model to state an unsupported cause. Hence the
explicit "cause unknown" rule and no mandatory time estimates.
