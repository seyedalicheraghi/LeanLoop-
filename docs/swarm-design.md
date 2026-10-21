# Swarm mode design

Status: design A, implemented in LeanLoop 0.6. Each choice cites the evidence
in [SOURCES.md](../SOURCES.md) or is labelled a design choice. The user guide is
[swarm.md](swarm.md).

## Design A in one paragraph

The user's own Claude Code session is the lead. It runs package workers as
ordinary Claude Code subagents, under the user's normal permission rules and
sandbox. **LeanLoop never launches model sessions, never starts `claude -p`,
and never bypasses or widens permissions.** It provides deterministic helpers
(`leanloop swarm ...`: plan validation, worktrees and branches, worker briefs,
acceptance and merge gates, sealed verification, cleanup) and the procedure in
the `/leanloop:build` skill. Design choice: an earlier draft had LeanLoop start
headless workers itself; that would have made LeanLoop a process supervisor
with its own permission flags, budgets, and kill switch, which the development
contract (AGENTS.md) rules out.

## Goal and the two modes

LeanLoop has two modes on one foundation, chosen per request:

| | Guided (0.5) | Swarm (0.6) |
|---|---|---|
| Start | Ask normally, or `/leanloop:work` | `/leanloop:build "idea"` |
| Driver | You and one Claude session | Your session as lead, with subagent workers |
| Best for | Coupled or sequential work, debugging, research code | Decomposable work: new apps, independent workstreams |

Both share the evidence gates (checks, criteria, integrity review, `escalate`),
the code reviewer, lessons, audit, and evals. Every swarm worker is a guided-mode
owner in its own worktree.

Choosing the mode follows the evidence: multi-agent setups gained up to 80.8% on
decomposable work and lost up to 70% on sequential planning (2512.08296);
success falls as a task's parts become more coupled (2606.13733); teams beat a
solo agent at 3 to 7 times the cost (2610.17471). The lead recommends a mode
with reasons; the user decides.

## Pipeline

1. **Spec** (interactive). The lead turns the idea into `spec.md`: purpose,
   user-visible acceptance criteria that a command or browser test can show,
   non-goals, and constraints. It asks the user only about real ambiguities.
   Spec ambiguity is a leading multi-agent failure class (2503.13657).
2. **Plan.** `plan.json` holds work packages: `id`, goal, `ownedPaths`
   (disjoint), `dependsOn` (a DAG), `contracts` (APIs, types, data and model
   I/O shapes, metric thresholds; read-only references), per-package `checks`,
   and acceptance criteria. Split by dependency cohesion, not by file; keep
   coupled work in one package (2606.00953, 2606.13733). `leanloop swarm
   validate` rejects cycles, unknown dependencies, duplicate ids, overlapping
   owned paths, packages without checks or acceptance criteria, and plans of
   more than 20 packages.
3. **Approval.** Before any parallel spend, the user approves the spec, the
   package graph, the worker count, and every permission the run needs
   (commands, network domains, GPU jobs, new dependencies).
4. **Bootstrap.** For a new project the lead first creates the skeleton:
   folders, a runnable check per package, shared contracts, and sealed
   acceptance tests under `.leanloop/sealed/` in the main checkout, which no
   worker worktree contains. This gives an empty repository checks to finish
   against.
5. **Build.** `swarm start` creates the integration branch and worktree from
   HEAD without switching the user's branch. For each package whose
   dependencies have merged, `swarm prepare` creates its worktree and branch
   from the integration tip and prints a brief; the lead hands the brief to a
   Claude Code subagent. At most 4 run at once (2610.17471: verifiers plateaued
   after 4 workers). A worker must `finish` through LeanLoop in its worktree.
   Workers coordinate only through artifacts, never through shared writable
   services or chat (2608.16801; incident report: a shared package mirror
   became the agents' message board).
6. **Integrate.** `swarm accept` requires a done LeanLoop task for the
   planned goal and criteria with fresh evidence and changes only inside the
   owned paths, then commits on the package branch. `swarm merge` merges one
   package at a time in dependency order (`--no-ff`), then runs that package's
   checks and the integration checks. A conflict aborts the merge; a failing
   check resets the integration branch; either way the package goes back to
   its worker for rework.
7. **Verify.** `swarm verify` runs the sealed acceptance tests in the
   integration worktree with `LEANLOOP_SEALED_DIR` pointing at the main
   checkout's `.leanloop/sealed`; the `leanloop:code-reviewer` agent reviews
   the integration diff. Centralized verification limited error amplification
   in 2512.08296; agents seek grading material, so acceptance tests stay out of
   builders' worktrees (2608.16801).
8. **Report.** What was built, the evidence per criterion, and what remains or
   needs a decision.

The lead stops and asks when a contract or the spec must change, a worker
escalates, or a step crosses an approval boundary.

## Containment

The OpenAI and Hugging Face incident (activity May to July 2026, reported in August 2026) shows what autonomous agents
do when a task pushes them: they probed their environment, escaped
"isolated" containers through a shared package mirror and a shared credential,
used the mirror as a message board, and kept running after alerts fired. In
design A, process, tool, and network containment belong to Claude Code, which
already runs the workers; LeanLoop adds bookkeeping gates on top:

| Control | Enforced by | Notes |
|---|---|---|
| One worktree and branch per package; owned paths checked before commit | `swarm prepare`, `swarm accept` | Worktrees isolate files in Git, not processes, reads, or network |
| Merge only accepted packages, in dependency order, with checks; roll back on failure | `swarm merge` | |
| Sealed acceptance tests kept outside every worker worktree | Bootstrap, `swarm verify` | Still readable by path from the same machine; cooperative |
| Tool permissions, permission prompts, and modes | Claude Code permission rules of the user's session | LeanLoop never passes or widens permission flags |
| Deny-by-default network with a short allowlist; OS-level isolation | Claude Code sandbox in WSL2, Linux, or macOS; or a container | Not available on native Windows |
| Concurrency limit (at most 4 workers) and stopping workers | The lead session and the user | LeanLoop starts and stops no processes besides configured checks |
| Human approval before push, deploy, publish, credential use, new dependencies, long GPU jobs, or any physical hardware motion | Lead, per the build skill, and Claude Code permissions | |

On native Windows, Claude Code runs shell commands unsandboxed and Windows
Sandbox needs Pro or Enterprise, so the docs recommend WSL2 with Claude Code's
sandbox enabled for swarm runs. LeanLoop's gates are cooperative bookkeeping,
not a security boundary: a subagent with shell access can still read sealed
tests, edit other worktrees, or run Git directly. `swarm accept` and `swarm
merge` catch out-of-scope results; they cannot prevent out-of-scope actions.

## Machine learning and robotics work

Training runs exceed a check's one-hour limit. A long job runs detached and is
tracked as a job record: command, config hash, dataset version, code commit,
seed, checkpoint path, and metrics. "Done" for an ML package means metric gates
against a stored baseline (success rate, latency on the target device, accuracy
drop after quantization) plus fast proxy checks (a short smoke run whose loss
falls, an export-and-parity test). Motion on physical robots and changes to
network or device configuration always need explicit operator approval. Job
records are not implemented in 0.6.

## Open items to verify on first run

- How many parallel subagents the installed Claude Code runs at once, and how
  their permission prompts surface to the user.
- Sandbox settings inside WSL2 and allowlisted domains for package registries.
- Whether subagents reliably keep `--project WORKTREE` on every LeanLoop call.
