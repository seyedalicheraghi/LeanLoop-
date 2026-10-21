# Development contract

- Keep the kit local and dependency-free. Do not add an LLM backend, telemetry,
  lifecycle hooks, or automatic package installation without an explicit requirement.
- Preserve existing project customizations. Never add force-overwrite or broad
  cleanup as a shortcut around installer conflicts.
- Treat the CLI as cooperative evidence bookkeeping, not a security boundary,
  authenticated review system, or proof of test quality.
- Changes to completion, snapshot, locking, process cleanup, lesson caps, or
  installer ownership require regression tests for the failing path and current behavior.
- `audit` stays read-only, never follows symlinks, and keeps its output bounded.
- Keep the skill and reviewer within the combined byte budget enforced by validation.
- Use the smallest relevant test selection while iterating. Before distribution,
  run `npm test`, `npm run validate`, and a local archive installation smoke test.
  Before publishing outside your machine, also run validation with
  `LEANLOOP_DENYLIST_FILE` pointing at a private terms file kept outside the package.
- Do not claim API savings from synthetic retrieval benchmarks. Record unknown
  measurement fields as unknown and keep quality regressions visible.
- Original implementation only. Cite public sources without copying incompatible
  code or introducing private project material into the package.
