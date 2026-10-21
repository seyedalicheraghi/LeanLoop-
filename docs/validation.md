# Validation record

## 0.6.0 swarm mode, code reviewer, and stronger gates (2026-10-21)

What changed: swarm mode (design A: `/leanloop:build` and `leanloop swarm`
helpers; LeanLoop starts no model sessions), the `leanloop:code-reviewer` agent
and `/leanloop:review`, `resume --decision` and the `ESCALATED` stop, integrity
over check-definition files, start-time manifests, scope
(`SCOPE_REVIEW_REQUIRED`), and flaky checks, the audit's AGENTS.md and
CLAUDE.local.md coverage, and a stricter eval post-check (TAP counts, frozen
assertions, fingerprint-checked ledger).

| Check | Observed result |
|---|---|
| `npm test`, Windows 11 (eval fixtures through Git Bash) | Node 24.13.1: 170 tests, 166 passed, 0 failed, 4 skipped |
| `npm test`, WSL Ubuntu 24.04, Node 18.19.1 (below the declared Node 22 engine) | `node --test tests/*.test.mjs` on a copy in `~/ll-final` (without .git, dist, .leanloop): 170 tests, 167 passed, 0 failed, 3 skipped |
| New regression tests | `tests/swarm.test.mjs` on real temporary Git repositories (validation, start, prepare ordering, accept refusing unfinished, mismatched, or out-of-scope work including `.leanloop/` paths, merge with conflict and failed-check rollback, sealed verification, status, abandon keeping dirty worktrees); escalation and `resume`; integrity without a base commit; check-definition files, including ignored ones; out-of-scope review; bounded check timeouts; Windows shim and path-casing cases; eval post-check TAP counts, frozen assert, and fingerprint-checked ledger; audit AGENTS.md, CLAUDE.local.md, and name sanitizing. Removing the ownership check, the rollback reset, the dependency gate, the `.leanloop` exemption fix, or the run-existence check each made a test fail |
| `npm run validate` | Passed on Windows 11 with Node 24.13.1 during the documentation update: 36 scripts, 65 Markdown files, no dependencies; work skill plus `leanloop-reviewer` 7,477 / 8,192 bytes; code reviewer 6,428 / 8,192; all skills and agents 20,463 / 24,576; `claude plugin validate --strict` passed. Rerun at release |
| Citations | The 8 arXiv IDs added for the code reviewer, plus 2606.00953 and 2610.17471, were matched against their arXiv abstract pages on 2026-10-21; every non-arXiv source in the new SOURCES.md sections opened, and the cited sections of the incident report (introduction, prior activity, security lessons) were read in its extracted text |
| Plugin install smoke test, private-term validation | With a throwaway `CLAUDE_CONFIG_DIR`, the local marketplace installed `leanloop@leanloop` 0.6.0: 5 skills, 2 agents, 0 hooks, 0 MCP servers, about 317 always-on tokens per session; the real configuration was untouched. A 14-term private list found no hits in the files to be committed |

Not done: no swarm run has driven real Claude Code subagents end to end, and
the open items in [swarm-design.md](swarm-design.md#open-items-to-verify-on-first-run)
are unverified. The behavior evals have not been run against Claude. No speed,
cost, or quality comparison of swarm and guided mode was made.

## 0.5.1 multi-component procedure (2026-10-20)

The work skill gained a "Multi-component changes" section that keeps only
rules with research or design backing (see [SOURCES.md](../SOURCES.md#multi-component-procedure-051)).
The work skill plus reviewer use 7,096 of 8,192 bytes. A new eval case,
`components-one-at-a-time`, and a regression test (a finished step keeps its
last checkpoint in `status`) were added. On WSL Ubuntu 24.04 with Node 18.19.1,
all 9 eval-suite tests passed, and the full suite passed 124 of 125 (1 Windows-only
skip); on Windows 11 with Node 24.13.1 it passed 114 of 125 (11 skipped). Two string-replace
bugs were found and fixed while building the case: a `$'` sequence in
replacement text expanded to the rest of the input, once in the eval generator
and once in the test helper.

## 0.5.0 Claude Code plugin (2026-10-20)

| Check | Observed result |
|---|---|
| `npm test`, Windows 11, Node 24.13.1 | 115 tests: 111 passed, 0 failed, 4 skipped (3 need file-symlink privilege; SIGTERM cannot reach a handler on Windows) |
| `npm test`, WSL Ubuntu 24.04, Node 18.19.1 (below the declared Node 22 engine) | 115 tests: 114 passed, 0 failed, 1 skipped (the Windows-only `.cmd` test) |
| New regression tests | Integrity gate (edited, deleted, and committed test changes; changed checks; `testPaths`), escalation, failure excerpts, checkpoint evidence, fail-to-pass history, lesson duplicates and anchors, plugin-mode `init`, orphaned-grandchild cleanup, Windows `.cmd` quoting, and the rewritten audit |
| `npm run validate` | 31 scripts; no dependencies; work skill plus reviewer 6,201 / 8,192 bytes; all skills plus reviewer 8,802 / 12,288 bytes; no invisible Unicode |
| `claude plugin validate --strict` (Claude Code 2.1.270) | Plugin manifest, marketplace manifest, skills, and agent passed |
| Plugin install smoke test | With a throwaway `CLAUDE_CONFIG_DIR`, `claude plugin marketplace add` and `claude plugin install leanloop@leanloop` succeeded; `claude plugin details` listed 3 skills, 1 agent, 0 hooks, 0 MCP servers, and about 183 always-on tokens per session |
| CLI on Windows | `init`, `doctor`, and an `npm test` check (through `cmd.exe`) ran natively |
| Private-term validation | 14 externally stored terms checked against the files to be committed; no hits |
| Citations | All 52 arXiv IDs matched arXiv's metadata; a full-text check of 61 quoted claims found none contradicted, corrected 19, and narrowed about 18 |

Behavior evals added after 0.5.0 (same day): five `claude plugin eval` cases,
a workspace post-check, and tests of the suite itself. On WSL Ubuntu 24.04 with
Node 18.19.1, all 8 suite tests passed: every fixture reproduced its problem,
every reference fix passed (the conflicting-test case stays impossible as
written), and every planted cheat was caught by the post-check. On Windows the
fixture tests skip, as plugin evals with Bash need Linux, macOS, or WSL2. The
suite has not yet been run against Claude.

Not done: no session ran Claude through the plugin's skills end to end, and no
evaluation compared outcomes with and without LeanLoop. The benchmarks were not
rerun; the context and fingerprint code they measure did not change.

## 0.4.0 rename to LeanLoop (2026-10-20)

Only names, paths, and the pre-rename install guard changed. Verified on WSL
Ubuntu 24.04 with Node 18.19.1 (below the declared Node 22 engine) and Git 2.43.0:

| Check | Observed result |
|---|---|
| `npm test` | 96 passed, 0 failed/cancelled/skipped (the 0.3.0 suite was also 95/95 here) |
| New regression test | A pre-rename `lean-workflow.json` or `.lean-workflow/install.json` is refused with `LEGACY_INSTALL`; observed failing with the guard removed |
| `npm run validate` | 31 scripts; no dependencies; skill plus reviewer 6,936 bytes |
| Private-term validation | 14 externally stored terms checked; no hits |
| Local archive smoke test | `portable` + `claude` install, no-op reinstall, `start`/`check`/`prove`/`finish`, `learn`, `audit`, and refusal of a legacy project passed |

On Windows 11 with Node 24.13.1, 67 of 96 tests pass (66 of 95 before the
rename). The same 29 need POSIX process-group verification or symlink creation,
which this release does not support on Windows. The benchmarks were not rerun for a rename.

## 0.3.0 reassessment (2026-10-20)

Verified on Linux with Node 22.23.2, npm 10.9.8, and Git 2.53.0:

| Check | Observed result |
|---|---|
| `npm test` | 95 passed, 0 failed/cancelled/skipped |
| `npm run validate` | 31 scripts, 10 Markdown files; no dependencies |
| Skill plus reviewer | 6,938 bytes, below the 8,192-byte limit |
| Private-term validation | 14 externally stored terms checked; no hits |
| `npm run benchmark` | 100,000 paths; 12 results; 1,001 serialized bytes |
| `node scripts/benchmark-large-repo.mjs 220000` | Full lifecycle passed; exact requested filename returned |
| Local archive smoke test | Portable, Copilot, Claude installs and a 0.2.0 upgrade passed |

Seven newly added regression scenarios were first observed failing against the
0.2.0 implementation. Fixes cover staged changes hidden by a combined HEAD diff,
known evaluation failures masked by unknown costs, hand-expanded lesson budgets,
incomplete audits reported as successful, exact model-name accounting, actual
serialized audit bounds, and package-manager declarations/manifest errors.
Additional tests cover cross-host name collisions, oversized customization files,
Git discovery failures, ambiguous lockfiles, and symlinks.

The archive tests run actual Node assertions through the copied runtime, check
proof/review gates with explicitly synthetic review attestations, verify staged
evidence invalidation, retain project instructions/configuration, reject local
customization conflicts, and migrate an old Copilot install to the portable
location. They test packaging/runtime behavior, not live-agent compliance.

At 220,000 tracked files (19,798,890-byte index listing), one run measured
`start` 338 ms, `status` 332 ms, `check` 818 ms, `prove` 329 ms, `finish` 342 ms,
`context` 298 ms, and `audit` 248 ms. The benchmark now asserts the exact top
filename and exits nonzero on failure. These are synthetic tiny-file timings,
not coding-quality, provider-cost, or general filesystem-latency guarantees.

Version 0.3.0 was reassessed directly with reproductions and regression tests.
No new independent live-model review or paid comparative experiment is claimed.
Actual API savings, cross-platform execution, and automatic skill invocation
remain unestablished. Public references and scoped limitations are recorded in
[SOURCES.md](../SOURCES.md) and [design.md](design.md).

## Historical 0.2.0 record

Source validation of 0.2.0 on 2026-10-20:

| Environment | Version |
|---|---|
| OS exercised | Linux x64 |
| Node | 22.23.2 |
| npm | 10.9.8 |
| Git | 2.53.0 |

### Reproducible checks

```sh
npm test
npm run validate
npm run benchmark
npm run benchmark:repo
```

- **84 automated tests passed**, with no failures, cancellations, or skips
  (64 from 0.1.0, updated for the new default install location, plus 20 new).
- JavaScript syntax, relative documentation links, manifest consistency,
  Agent Skills frontmatter, and the zero-dependency policy passed validation.
  With a private terms file supplied through `LEANLOOP_DENYLIST_FILE`,
  14 terms were checked with no hits.
- The workflow skill and reviewer total **5,930 bytes** (0.1.0: 7,212), below
  their combined 8 KiB budget.
- The synthetic 100,000-filename run returned **12 paths in 1,001 bytes**, below
  the 8 KiB serialized context budget, in about 50 ms.
- `benchmark:repo` with 150,000 tracked files (13.4 MB index listing): `start`
  197 ms, `status` 197 ms, `check` 523 ms, `prove` 194 ms, `finish` 204 ms,
  `context` 173 ms, `audit` 112 ms. These are not latency guarantees.
- A/B on a 220,000-file repository (19.8 MB index listing): 0.1.0 `start` failed
  (`GIT_FAILED`, buffer exceeded) and `context` failed (`INVENTORY_LIMIT`); 0.2.0
  completed `start` in 0.37 s, `check` in 0.87 s, and ranked the right file.
- A local archive installation smoke test passed: dry run, install (15 files),
  `doctor` suggestions, the full task loop with a lesson recorded after proof,
  a clean `audit`, upgrading a real 0.1.0 installation in place, migrating it to
  the portable location, and the `claude` host.

Regression tests confirm specific failure paths: a lesson write cannot make
evidence stale (verified to fail without the fix), lesson caps refuse growth
without changing the file, hand-written lesson text is never dropped, `audit`
writes nothing and does not follow symlinks, audit output stays bounded with
pathological inputs, an empty host registry cannot retire installed files, and
index listings larger than the old 16 MiB cap are checked with every unsafe
flag still failing closed.

### Independent review follow-through

0.1.0: a separate read-only correctness review identified six actionable areas
(stranded checking state and lock recovery, carried-over failures, incremental
output assertions, registry-based upgrades, readable state without freshness,
and Git routing variables). They were fixed with regression tests.

0.2.0: a separate read-only review of the 0.1.0-to-0.2.0 code diff found no
high-severity issues and six medium/low ones: an empty registry host list could
retire every managed file; a repeated lessons header line could be dropped
silently; audit output was not bounded for pathological model and agent names;
top-level referenced files were missed; large lockfiles produced the wrong
package-manager suggestion; nested guides were capped at 200 without notice.
All six were fixed with regression tests and the full suite was rerun. This is
not a claim that the reviewer re-audited every amendment or that another
reviewer cannot find defects.

### Not established by this record

- Lower real-world API cost, token usage, or time-to-accepted-change.
- A statistically significant advantage over another workflow or provider.
- Live-agent instruction compliance across every host and model. Skill discovery
  locations come from official documentation; Codex and Gemini CLI discovery was
  not exercised on this machine.
- Windows verification support, or an executed macOS test matrix.
- Sandbox isolation, authenticated reviewers, or immunity to a malicious workspace.

Logs and history are bounded per record/run, not subject to automatic total-disk
retention. They remain local, ignored, and operator-managed. See
[the design contract](design.md) and [controlled evaluation](evaluation.md).
