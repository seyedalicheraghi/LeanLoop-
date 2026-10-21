# Evaluate before claiming an improvement

Fewer agents and shorter outputs are not the objective by themselves. Measure
accepted engineering outcomes, regressions, elapsed time, and actual provider
usage under comparable conditions.

## Controlled task set

Choose at least 20 representative tasks across:

- Small regressions and boundary conditions.
- Changes spanning an API and its consumers.
- Large-repository localization.
- Integration failures and unfamiliar components.
- High-risk changes needing independent review.

For every task, freeze a repository revision and acceptance tests before either
workflow sees it. Use isolated worktrees and the same model, tools, permissions,
retrieval access, token/time budget, and starting information. Alternate workflow
order and use at least three trials where affordable. Do not optimize only on
the evaluation set.

The old workflow is the baseline; the kit is the candidate. A model upgrade is
a separate experiment. Save `audit` output for both setups so the structural
difference (potential instruction bytes, declared agents/hooks, memory) is
recorded next to results. Audit data is not observed prompt usage. Keep failed
and timed-out attempts in the data; do not measure only tasks the candidate finishes.

If the baseline assigns different models to different roles, first use the same
model across both architectures to isolate coordination effects. Compare the
original mixed-model system separately as an end-to-end product comparison, not
as evidence that coordination alone caused a difference.

## Record observed data

Use one JSONL file per variant, one row per task/trial:

```json
{"task":"pagination-boundary","trial":1,"revision":"immutable-revision","model":"same-selected-model","control":"same-tools-budget-and-environment","success":true,"elapsedMs":85000,"costUsd":null,"inputTokens":null,"outputTokens":null}
```

`success` must come from the frozen acceptance checks and review requirements,
not from the agent saying it finished. `elapsedMs` includes orchestration and
verification. Record provider-reported cost and token usage; unknown values are
`null` or omitted, never guessed from response length.

Use the same `task`, `trial`, `revision`, `model`, and `control` labels for paired
runs. The control label should identify a written record of the fixed conditions.
The tool verifies matching labels, not whether the experimenter actually held
those conditions constant.

```sh
node scripts/compare-runs.mjs baseline.jsonl candidate.jsonl
```

The comparator:

- Rejects empty, malformed, duplicate, unpaired, and mismatched-control records.
- Reports successes and regressions, not just aggregate averages.
- Compares latency on pairs where both variants succeeded, as well as all runs.
- Keeps missing usage/cost data unknown.
- Returns nonzero for regressions, a failed observed gate, or insufficient data.

The report includes individual `gates` with true, false, or null (unknown) values.
A known quality, latency, or cost failure takes precedence over missing metrics:
losing a baseline success is `fail`, not `insufficient-data`, even if every cost
is unknown or there are no common successes. Only a comparison with no known
failure and missing required measurements returns `insufficient-data`.

The gate is descriptive: no lost baseline successes, no fewer total successes,
no worse common-success median latency, and no higher total reported cost.
It is not statistical significance or evidence of general superiority. Inspect
per-task failures and uncertainty; medians can hide expensive outliers.

## Synthetic scalability check

```sh
npm run benchmark
```

This ranks 100,000 synthetic filenames and asserts a 12-path default and an actual
JSON output size below 8 KiB. It measures in-memory filename selection only.
It does not measure Git indexing, filesystem latency, semantic retrieval quality,
provider tokens, task success, or API savings.

## Independent review packet

Give another reviewer:

1. This source package, [design boundaries](design.md), and [source provenance](../SOURCES.md).
2. The exact revision/archive digest and `npm test` / `npm run validate` outputs.
3. A representative installed-project fixture with its chosen commands.
4. The controlled comparison records, including failures and unknown metrics.
5. A request for concrete failing scenarios rather than style preferences.

Useful adversarial scenarios include:

- Missing executables, zero-test success output, timeouts, interrupted checks,
  and ordinary child processes surviving their parent.
- Source changes during or after verification, partial check selection, stale
  review, and a claimed acceptance result without passing checks.
- Existing customizations, symlinked destinations, malformed state, concurrent
  mutation, and stale locks.
- Large/multibyte paths, excessive output, and ignored environment changes.
- Missing cost data, mismatched models, and faster-but-incorrect results.

Do not send private project code, logs, credentials, or evaluation data to an
external provider without authorization. Public package code and synthetic
fixtures are sufficient for the package-level checks.
