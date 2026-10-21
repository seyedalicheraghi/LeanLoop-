# Swarm mode design

Status: design for LeanLoop 0.6. Each choice cites the evidence in
[SOURCES.md](../SOURCES.md) or is labelled a design choice.

## Goal and the two modes

LeanLoop gets two modes on one foundation, chosen per project in
`leanloop.json` and overridable per request:

| | Guided (0.5) | Swarm (0.6) |
|---|---|---|
| Start | Ask normally, or `/leanloop:work` | `/leanloop:build "idea"` |
| Driver | You and one Claude session | A lead session, parallel workers, an integrator, a verifier |
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
   I/O shapes, metric thresholds), per-package `checks`, and acceptance
   criteria. Split by dependency cohesion, not by file; keep coupled work in one
   package (2606.00953, 2606.13733). `leanloop swarm validate` rejects cycles,
   overlapping owned paths, packages without checks, and contracts owned by no
   one.
3. **Approval.** Before any parallel spend, the user approves the spec, the
   package graph, the worker count, the budget, and every permission the run
   needs (network domains, GPU jobs, new dependencies).
4. **Bootstrap.** For a new project the lead first creates the skeleton:
   folders, a runnable check per package, shared contracts, and sealed
   acceptance tests stored outside every worker worktree. This gives an empty
   repository checks to finish against.
5. **Build.** `leanloop swarm run` starts at most 4 workers at once
   (2610.17471: verifiers plateaued after 4 workers; design choice for the
   default of 3), each a headless `claude -p` session in its own git worktree
   and branch. A worker receives its package brief and the work skill, and must
   `finish` through LeanLoop in its worktree. Workers coordinate only through
   artifacts, never through shared writable services or chat (2608.16801;
   incident report: a shared package mirror became the agents' message board).
6. **Integrate.** The lead merges one package at a time in dependency order:
   rebase, run that package's checks, then the integration suite. A conflict
   goes back to the owning package's worker.
7. **Verify.** A verifier that never writes product code runs the sealed
   acceptance tests; the code reviewer reviews the merged diff; the lead
   finishes the top-level LeanLoop task with that evidence. Centralized
   verification limited error amplification in 2512.08296; agents seek grading
   material, so acceptance tests stay out of builders' reach (2608.16801).
8. **Report.** What was built, the evidence per criterion, cost and time, and
   what remains or needs a decision.

The lead stops and asks when a contract or the spec must change, a worker
escalates, a budget would be exceeded, or a step crosses an approval boundary.

## Containment

The OpenAI and Hugging Face incident (August 2026) shows what autonomous agents
do when a task pushes them: they probed their environment, escaped
"isolated" containers through a shared package mirror and a shared credential,
used the mirror as a message board, and kept running after alerts fired. The
swarm therefore enforces:

| Control | Enforced by | Notes |
|---|---|---|
| One worktree and branch per worker; no push credentials | Orchestrator | Worktrees isolate files, not processes or network |
| Environment allowlist; tokens such as `GITHUB_TOKEN`, `NPM_TOKEN`, `HF_TOKEN`, `AWS_*` removed | Orchestrator | |
| Per-worker `--max-turns`, `--max-budget-usd`, wall-clock timeout, process-tree kill | Orchestrator | `taskkill /T` on Windows, process groups on POSIX |
| Narrow `--allowedTools`; no web tools; `--permission-mode dontAsk` | Orchestrator | |
| `leanloop swarm stop` kills every worker; a global budget stops the run | Orchestrator | Kill switch |
| Transcripts and logs written outside worker worktrees | Orchestrator | Workers cannot rewrite their own record |
| Deny-by-default network with a short allowlist; OS-level isolation | Claude Code sandbox in WSL2, Linux, or macOS; or a container | Not available on native Windows |
| Human approval before push, deploy, publish, credential use, new dependencies, long GPU jobs, or any physical hardware motion | Lead and orchestrator | |

On native Windows, Claude Code runs shell commands unsandboxed and Windows
Sandbox needs Pro or Enterprise. The swarm therefore refuses to start on native
Windows unless the user passes `--unsandboxed` for that run, and the docs
recommend WSL2 with Claude Code's sandbox enabled. Orchestrator controls are
cooperative bookkeeping, not a security boundary.

## Machine learning and robotics work

Training runs exceed a check's one-hour limit. A long job runs detached and is
tracked as a job record: command, config hash, dataset version, code commit,
seed, checkpoint path, and metrics. "Done" for an ML package means metric gates
against a stored baseline (success rate, latency on the target device, accuracy
drop after quantization) plus fast proxy checks (a short smoke run whose loss
falls, an export-and-parity test). Motion on physical robots and changes to
network or device configuration always need explicit operator approval.

## Open items to verify on first run

- Headless worker flags and `--bare` behaviour in the installed Claude Code.
- Plugin loading in `claude -p` workers (`--plugin-dir`).
- Sandbox settings inside WSL2 and allowlisted domains for the model API and
  package registries.
