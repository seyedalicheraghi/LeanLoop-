# Development contract

- LeanLoop is a Claude Code plugin. Keep it local and dependency-free. Do not add
  an LLM backend, telemetry, hooks, MCP servers, `bin/` PATH additions, or
  automatic package installation without an explicit requirement.
- Preserve existing project customizations. `init` creates only `leanloop.json`
  and `.leanloop/.gitignore`; never add force-overwrite or broad cleanup.
- Treat the CLI as cooperative evidence bookkeeping, not a security boundary,
  authenticated review system, or proof of test quality.
- Changes to completion, integrity, snapshot, locking, process cleanup (POSIX and
  Windows), lesson caps, or `init` require regression tests for the failing path
  and current behavior.
- `audit` stays read-only, never follows symlinks, and keeps its output bounded.
- Keep the work skill plus reviewer within 8 KiB and all skills plus reviewer
  within 12 KiB; validation enforces both. Keep skill descriptions short: every
  enabled plugin pays for them in each session.
- Write invisible or bidirectional Unicode only as escape sequences; validation
  rejects literal ones anywhere in the package.
- Use the smallest relevant test selection while iterating. Before distribution,
  run `npm test` on Windows and on Linux or macOS, `npm run validate` (which runs
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
