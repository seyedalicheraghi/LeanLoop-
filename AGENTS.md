# Development contract

- LeanLoop is a Claude Code plugin. Keep it local and dependency-free. Do not add
  an LLM backend, telemetry, hooks, MCP servers, `bin/` PATH additions, or
  automatic package installation without an explicit requirement.
- Preserve existing project customizations. `init` creates only `leanloop.json`
  and `.leanloop/.gitignore`; never add force-overwrite or broad cleanup.
- Treat the CLI as cooperative evidence bookkeeping, not a security boundary,
  authenticated review system, or proof of test quality.
- Swarm mode exists because the user explicitly requested it (0.6.0), and the
  user chose design A (docs/swarm-design.md): the user's own Claude Code session
  is the lead and runs package workers as ordinary subagents under the user's
  normal permission rules and sandbox. LeanLoop only provides deterministic
  helpers (`leanloop swarm ...`) and the `/leanloop:build` procedure. LeanLoop
  must not launch model sessions (including `claude -p`), pass or widen
  permission flags, or bypass permissions without a new explicit requirement
  from the user and a sandbox that contains those sessions.
- Swarm helpers may create, commit to, merge into, reset, and delete only the
  run's own branches and worktrees under `.leanloop/worktrees/RUN`; never the
  user's checked-out branch or worktree. Changes to plan validation, accept,
  merge, rollback, verify, or abandon require regression tests on real
  temporary Git repositories.
- Changes to completion, integrity (test files, check configuration,
  check-definition files, scope, start-time manifests), escalation and `resume`,
  snapshot, locking, process cleanup (POSIX and Windows), lesson caps, or `init`
  require regression tests for the failing path and current behavior.
- `audit` stays read-only, never follows symlinks, and keeps its output bounded.
- Keep the work skill plus `leanloop-reviewer` within 8 KiB, the code reviewer
  within 8 KiB, and all skills and agents together within 24 KiB; validation
  enforces all three. Keep skill descriptions short: every enabled plugin pays
  for them in each session. `setup`, `audit`, `review`, and `build` stay
  user-invoked (`disable-model-invocation`).
- Write invisible or bidirectional Unicode only as escape sequences; validation
  rejects literal ones anywhere in the package.
- Every behavior eval case needs a scaffold, deterministic graders where
  possible, a binary judge rubric only for wording, post-check expectations, and
  a reference fix and cheat in tests/evals.test.mjs. Running evals bills model
  usage: run them only when the user asks, with a pinned model and a cost cap.
- Node 22+ is the declared engine, but keep syntax Node 18-compatible: the suite
  also runs on WSL Ubuntu with Node 18. Use a function replacer in
  `String.replace` whenever the replacement text may contain `$`.
- Use the smallest relevant test selection while iterating. Before distribution,
  run `npm test` on Windows (with Git Bash on `PATH` for the eval fixtures) and
  on Linux or macOS, `npm run validate` (which runs
  `claude plugin validate --strict` when Claude Code is installed), and a local
  plugin smoke test. Before publishing outside your machine, also run validation
  with `LEANLOOP_DENYLIST_FILE` pointing at a private terms file kept outside
  the package.
- Do not claim API savings or quality gains from synthetic benchmarks or from
  papers that did not evaluate LeanLoop. Record unknown measurement fields as
  unknown and keep quality regressions visible.
- Original implementation only. Cite public sources, verified against their
  primary page, without copying incompatible code or introducing private project
  material into the package.
