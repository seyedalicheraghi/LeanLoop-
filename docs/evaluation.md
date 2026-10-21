# Evaluate before claiming an improvement

LeanLoop has not been evaluated with this procedure. Nothing in this package
shows that it saves money or time or raises success rates, and the synthetic
benchmarks below are not evidence of either. This page is a procedure for
finding out on your own work with Claude Code, in a way that small samples and
favorable impressions cannot fool.

The experiment compares two arms that differ in one thing:

- **A, baseline:** Claude Code with the LeanLoop plugin disabled.
- **B, candidate:** the same Claude Code version, model, and settings with
  LeanLoop enabled.

Differences are reported as B − A, per task first and then averaged.

## Why small A/B tests mislead

- **Single runs are noisy.** Rerunning the same agent on SWE-bench Verified
  moved single-run pass@1 by 2.2–6.0 points, with a standard deviation above
  1.5 points even at temperature 0 ([2602.07150](https://arxiv.org/abs/2602.07150)).
  One run per task cannot separate a few-point effect from luck. Run several
  trials, plan the sample size, and report pass@k and pass^k next to pass@1.
- **Trials of one task are not independent.** Cluster standard errors by task
  (they can be roughly three times the naive figure), and compare two systems
  through paired per-task differences when both ran the same tasks
  ([2411.00640](https://arxiv.org/abs/2411.00640)).
- **Reliability is not capability.** pass^k, success in all k trials, exposes
  inconsistency that an average hides ([2406.12045](https://arxiv.org/abs/2406.12045)).
- **Cost and accuracy belong together,** and tasks used for tuning do not belong
  in the test set ([2407.01502](https://arxiv.org/abs/2407.01502)).
- **Impressions are not measurements.** In a randomized trial, experienced
  developers believed AI tools made them about 20% faster while their measured
  completion time was 19% slower ([2507.09089](https://arxiv.org/abs/2507.09089)).
- **Passing tests is not correctness.** Patches that pass the visible tests can
  still be wrong ([2503.15223](https://arxiv.org/abs/2503.15223)), and agents
  sometimes edit or special-case tests to make them pass
  ([2510.20270](https://arxiv.org/abs/2510.20270)).
- **Effects depend on the work.** Results vary strongly by task type and by
  repository ([2602.08915](https://arxiv.org/abs/2602.08915),
  [2606.28235](https://arxiv.org/abs/2606.28235)), and token use for the same
  task can vary up to 30x between runs ([2604.22750](https://arxiv.org/abs/2604.22750)).

## Controlled task set

Choose 10–30 real tasks from your own repositories. For each task, fix these
before either arm runs:

1. A written prompt, stored as a file and given verbatim to both arms.
2. A frozen base commit (`revision`). Every run starts from it.
3. Acceptance checks: the project's own build, lint, and test commands that
   decide `success`.
4. Where possible, held-out tests: tests that judge the change but that the
   agent never sees. Keep them outside the repository and outside any directory
   the agent can read, and copy them in only to score.

Rules for the set:

- **Held out from tuning.** Do not use these tasks to adjust LeanLoop settings,
  `CLAUDE.md`, prompts, or checks. A task you tuned on is a development task;
  drop it from the evaluation set.
- **Stratified.** Mix task types, such as small regressions and boundary
  conditions, features, refactors, changes spanning an API and its consumers,
  localization in a large repository, integration failures, and high-risk
  changes that need review. Use more than one repository if you can. Label rows
  with `taskType` and `repo` so the report can break results down.
- **Real difficulty.** Include tasks the baseline sometimes fails. A set every
  arm always solves can show only time and cost differences.
- **1–2 impossible-task canaries.** A canary looks like a normal task, but its
  acceptance check cannot legitimately pass, for example a test that asserts two
  contradictory behaviors. Any "success" on a canary means a check was edited,
  skipped, or special-cased, or the scorer is broken. Mark canary rows with
  `"canary": true`; they are reported separately and kept out of success rates.

Ten paired tasks is the minimum before the comparison reports a pass or a
direction. With the noise above, 10–30 tasks detect only large differences; the
report's power note estimates how many tasks a 5-point difference would need.

## Run each arm

- **Hold everything else fixed:** Claude Code version, model, effort and other
  settings, permission flags, allowed tools, MCP servers, `CLAUDE.md`, other
  plugins and hooks, and time or turn limits. Only LeanLoop differs. Toggle it
  with Claude Code's plugin manager (`/plugin`) and confirm which arm is active
  before each batch. If a repository already commits LeanLoop configuration, the
  baseline is not "without LeanLoop"; record how you removed it.
- **At least 3 trials per task per arm.** More trials sharpen each task's
  estimate; more tasks narrow the overall interval faster.
- **Interleave.** Alternate arms and shuffle task order (for example A B B A per
  task) so time of day, service load, or an update does not land on one arm. A
  model or Claude Code upgrade during the experiment starts a new experiment.
- **Fresh state every run:** a new worktree at the base commit, with no
  carried-over `.leanloop/` state, memory, or caches.
- **Headless and timed by the clock.** Record wall-clock time from timestamps
  taken around the run, never from how long it felt:

```sh
git worktree add --detach "../eval/$task-$arm-$trial" "$base"
cd "../eval/$task-$arm-$trial"
start=$(node -e 'console.log(Date.now())')
# Add the same permission flags to both arms.
claude -p "$(cat "$prompt_file")" --output-format json > "$log_dir/$task-$arm-$trial.json"
end=$(node -e 'console.log(Date.now())')
echo "elapsedMs=$((end - start))"
node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(JSON.stringify({ costUsd: r.total_cost_usd ?? null, session: r.session_id ?? null }));' \
  "$log_dir/$task-$arm-$trial.json"
```

`claude -p --output-format json` reports `total_cost_usd` and `session_id`.
Record the cost as `costUsd` and keep the session id in your notes so every row
can be traced to its transcript. This is the cost Claude Code reports, which can
differ from your bill; if a run does not report it, record `null`. Record tokens
only from usage reported for that run, and write down which usage fields you
added together.

Keep every attempt. Timeouts, crashes, and refusals are failures with their
measured elapsed time. Dropping them biases the comparison toward whichever arm
fails more often.

## Score each run

Score after the session ends, with commands rather than the agent's own report:

| Field | How to score it |
|---|---|
| `success` | The task's acceptance checks pass on the final working tree. |
| `heldOutPassed` | Copy the held-out tests in and run them. Omit it, or use `null`, for tasks without held-out tests. |
| `testFilesChanged` | `true` if the run modified, deleted, or renamed an existing test, fixture, snapshot, or test configuration file. New test files do not count. For example, filter `git diff --name-only --diff-filter=MDR "$base"` by your test paths and review the hits. |
| `submitted` | `true` if the run ended with a change or answer presented as done; `false` if it stopped, timed out, or gave up. |

A run that submitted but failed is the most costly failure: a broken change that
looks finished. The report counts it separately. A success that changed tests is
not automatically cheating, because some tasks require test updates, but the
comparison flags any increase so that someone reads those diffs.

## Record observed data

Use one JSONL file per arm, one row per run:

```json
{"task":"pagination-boundary","trial":1,"revision":"3f2c1ab","model":"same-selected-model","control":"eval-plan-v1","taskType":"bugfix","repo":"billing-api","success":true,"submitted":true,"testFilesChanged":false,"heldOutPassed":true,"elapsedMs":85000,"costUsd":0.41,"inputTokens":null,"outputTokens":null}
```

| Field | Required | Meaning |
|---|---|---|
| `task` | yes | Task identifier, the same in both files. |
| `revision`, `model`, `control` | yes | Base commit, model, and a label naming your written record of the fixed conditions. Identical for every row of a task in both files. |
| `success` | yes | The acceptance checks passed. |
| `elapsedMs` | yes | Measured wall-clock milliseconds, greater than 0. |
| `trial` | no | Positive integer, unique per task within a file. If it is omitted for every row of a task, rows are numbered in file order. |
| `taskType`, `repo` | no | Labels for the stratified breakdown. They must not conflict between rows of one task. |
| `submitted`, `testFilesChanged`, `heldOutPassed` | no | Booleans scored as above; `null` or omitted when unknown. |
| `canary` | no | `true` for impossible-task canaries. |
| `costUsd`, `inputTokens`, `outputTokens` | no | Reported values, never estimates; `null` or omitted when unknown. Tokens are integers. |

Unknown means `null` or omitted, never `0` and never a guess from response
length. Rows in the 0.4 format remain valid. The tool checks that labels match;
it cannot check that you actually held the conditions constant.

## Compare

```sh
node scripts/compare-runs.mjs baseline.jsonl candidate.jsonl
```

The output is JSON. Exit code 0 means `observedGate` is `pass`; 1 means `fail` or
`insufficient-data`; 2 means the input was rejected (malformed rows, duplicate
trials, an uncontrolled `revision`, `model`, or `control`, conflicting task
labels, or no task present in both files).

Tasks found in only one file are listed under `pairing` and excluded. Canaries
are reported under `canaries`. Everything else is computed over the non-canary
tasks present in both files, and each task counts once however many trials it has.

### Per arm

`baseline` and `candidate` each report:

- `tasks`, `trials`, and `successful`.
- `passAt1`: the mean of per-task success rates. It equals the overall success
  rate when every task has the same number of trials.
- `passAtK` and `passHatK`: the chance that at least one, or all, of k trials
  succeed, from the unbiased per-task estimator
  ([2107.03374](https://arxiv.org/abs/2107.03374)) averaged over tasks. The
  top-level `k` is the fewest trials any task has in either arm.
- `submittedButFailed`, `testFileChangesAmongSuccesses` with its rate, and
  `heldOutPassRate` over the `heldOutTasks` that have held-out results for every trial.
- `medianElapsedMs` and `meanElapsedMs`.
- `costUsd` (total), `meanCostPerTrialUsd`, and `costPerSuccessUsd`: all spending,
  failures included, divided by successful runs. Each is `null` if any run in the
  arm lacks a cost, and `costPerSuccessUsd` is also `null` when nothing succeeded.
- `inputTokens` and `outputTokens`: total, mean, median, min, and max, or `null`
  if any run lacks them. The min and max show run-to-run spread.

### Paired difference

`successDifference` takes, for every paired task, the candidate's success rate
minus the baseline's. It reports the mean difference, the standard error of that
mean over tasks, a 95% normal-approximation interval (`ci95`), and the number of
paired tasks. Each task is one cluster, so repeated trials do not count as
independent evidence. `naiveStandardError` treats every trial as independent and
ignores pairing; it is shown only so you can see what clustering changes.

`verdict` is one of:

- `not distinguishable`: the interval includes 0, or the difference is smaller
  than 3 percentage points.
- `insufficient data`: fewer than 2 paired tasks, or fewer than 10 when the
  interval would otherwise suggest a direction.
- `candidate higher` or `candidate lower`: at least 10 paired tasks, an interval
  that excludes 0, and a difference of at least 3 points.

`heldOutDifference` repeats the paired analysis for held-out pass rates when
they were recorded.

`power.pairedTasksNeeded` approximates how many paired tasks would detect a
5-point difference (two-sided alpha 0.05, 80% power) at the observed standard
deviation of per-task differences and the current trials per task. It is a
normal-approximation planning aid, not a guarantee.

### Strata

`strata.taskType` and `strata.repo` repeat the paired analysis for each task
type and repository when those labels are present; `value: null` collects
unlabeled tasks. Strata are small, so most will say `insufficient data`. Use them
to see where an effect or a regression concentrates, then test that slice with
more tasks.

### Gates

Each entry in `gates` is `true`, `false` (a known regression), or `null` (unknown):

| Gate | `false` when | Present |
|---|---|---|
| `successRate` | The mean paired success difference is below 0. | Always |
| `testFileChangesAmongSuccesses` | A larger share of the candidate's successes changed tests. | When recorded |
| `heldOutPassRate` | The mean paired held-out difference is below 0. | When recorded |
| `noCandidateCanarySuccess` | Any candidate canary run succeeded. | When canaries exist |
| `commonSuccessLatency` | On tasks both arms solved at least once, the candidate's median successful time is higher. | Always |
| `meanCostPerTrial` | The candidate's task-weighted mean cost per run is higher. | Always |
| `minimumPairedTasks` | Never false; `null` below 10 paired tasks. | Always |
| `allTasksPaired` | Never false; `null` when a task appears in only one file. | Always |

`observedGate` is `fail` if any gate is false, otherwise `insufficient-data` if
any gate is null, otherwise `pass`. A known quality, latency, or cost regression
therefore takes precedence over unknown cost or token data: lower success, more
test-file changes, or lower held-out results are `fail` even if every cost is missing.

Gates compare observed point estimates, so they are deliberately strict: a drop
inside the noise still fails. Read a `fail` together with the verdict and the
interval. A `pass` means that no measured axis got worse on these tasks and that
enough tasks were paired; it is not statistical significance or general
superiority. `regressions` lists up to 20 tasks whose success rate fell and
`improvementCount` counts the tasks where it rose, so regressions stay visible
even when the average improves. `notRecorded` and `warnings` name missing
measurements and design problems such as `k` below 3.

## Read the result honestly

- With 10–30 tasks, `not distinguishable` is the likely verdict unless the effect
  is large. It means the experiment could not tell the arms apart, not that they
  are equal.
- Do not rerun until the result looks good. Every run belongs in the data;
  choosing runs or tasks after seeing results invalidates the interval.
- Report success, cost, and time together, with `k`, the number of paired tasks,
  the verdict and interval, canary results, and the tasks that regressed.
- Resolve any canary success before reading anything else; it is a scoring or
  integrity problem.
- Results hold for your tasks, repositories, model, and settings at that time.
  A model upgrade is a separate experiment. If a baseline assigns different
  models to different roles, first compare with the same model in both arms,
  then evaluate the mixed-model setup end to end as a product comparison.
- If you use the `audit` command, save its output for both arms. Audit byte counts
  describe configuration size, not observed prompt usage, cost, or speed.

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
4. Both JSONL files and the comparison output, including failures, canaries, and
   unknown metrics.
5. A request for concrete failing scenarios rather than style preferences.

Useful adversarial scenarios include:

- Missing executables, zero-test success output, timeouts, interrupted checks,
  and ordinary child processes surviving their parent.
- Source changes during or after verification, partial check selection, stale
  review, and a claimed acceptance result without passing checks.
- Existing customizations, symlinked destinations, malformed state, concurrent
  mutation, and stale locks.
- Large/multibyte paths, excessive output, and ignored environment changes.
- Missing cost data, mismatched models, faster-but-incorrect results, edited
  tests, and canary successes.

Do not send private project code, logs, credentials, or evaluation data to an
external provider without authorization. Public package code and synthetic
fixtures are sufficient for the package-level checks.
