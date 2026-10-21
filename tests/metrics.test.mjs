import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareRuns, MIN_PAIRED_TASKS, pairedDifference, parseRuns, passAtK, passHatK } from '../lib/metrics.mjs';

const row = overrides => ({
  task: 'boundary-fix', trial: 1, revision: 'fixture-v1', model: 'same-model',
  control: 'same-tools-and-budget', success: true, elapsedMs: 1000, costUsd: 1, ...overrides,
});
const parsed = rows => parseRuns(rows.map(value => JSON.stringify(value)).join('\n'));
// One task's trials from a list of outcomes, e.g. trials('a', [true, false, true]).
const trials = (task, outcomes, overrides = {}) =>
  outcomes.map((success, index) => row({ task, trial: index + 1, success, ...overrides }));
// An arm from { task: outcomes }; overrides are an object or a function of the task name.
const arm = (spec, overrides = {}) => parsed(Object.entries(spec).flatMap(([task, outcomes]) =>
  trials(task, outcomes, typeof overrides === 'function' ? overrides(task) : overrides)));
const many = (count, outcomes, prefix = 'task') =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`${prefix}-${index + 1}`, outcomes]));
// Reported rates and differences are rounded to 4 decimals for display.
const close = (actual, expected, tolerance = 1e-4) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);

test('paired improvements pass only with enough paired tasks and never invent token measurements', () => {
  const report = compareRuns(arm(many(10, [true])), arm(many(10, [true]), { elapsedMs: 800, costUsd: 0.5 }));
  assert.equal(report.observedGate, 'pass');
  assert.equal(report.baseline.inputTokens, null);
  assert.equal(report.commonSuccessTasks, 10);
  assert.equal(report.successDifference.verdict, 'not distinguishable');
  const single = compareRuns(parsed([row({})]), parsed([row({ elapsedMs: 800, costUsd: 0.5 })]));
  assert.equal(single.gates.minimumPairedTasks, null);
  assert.equal(single.observedGate, 'insufficient-data');
  assert.ok(single.warnings.some(warning => warning.includes(`at least ${MIN_PAIRED_TASKS}`)));
});

test('missing costs are unknown, not a free candidate or an improvement claim', () => {
  const report = compareRuns(arm(many(10, [true])), arm(many(10, [true]), task => (task === 'task-1' ? { costUsd: null } : {})));
  assert.equal(report.baseline.costUsd, 10);
  assert.equal(report.candidate.costUsd, null);
  assert.equal(report.candidate.meanCostPerTrialUsd, null);
  assert.equal(report.candidate.costPerSuccessUsd, null);
  assert.equal(report.gates.meanCostPerTrial, null);
  assert.equal(report.observedGate, 'insufficient-data');
  assert.ok(!report.notRecorded.includes('costUsd'));
  const unrecorded = compareRuns(arm(many(10, [true]), { costUsd: null }), arm(many(10, [true]), { costUsd: null }));
  assert.ok(unrecorded.notRecorded.includes('costUsd'));
  assert.equal(unrecorded.baseline.costPerSuccessUsd, null);
  assert.equal(unrecorded.observedGate, 'insufficient-data');
});

test('success regressions cannot be hidden by faster failures', () => {
  const before = parsed([row({}), row({ task: 'second' })]);
  const after = parsed([row({ elapsedMs: 1, success: false }), row({ task: 'second', elapsedMs: 500 })]);
  const report = compareRuns(before, after);
  assert.equal(report.regressionCount, 1);
  assert.deepEqual(report.regressions[0], {
    task: 'boundary-fix', baselineSuccesses: 1, baselineTrials: 1, candidateSuccesses: 0, candidateTrials: 1,
  });
  assert.equal(report.gates.successRate, false);
  assert.equal(report.observedGate, 'fail');
  assert.equal(report.commonSuccessMedianElapsedMs.candidate, 500);
});

test('known failures take precedence over missing costs and missing common successes', () => {
  const baseline = parsed([row({ costUsd: null })]);
  for (const candidate of [
    row({ costUsd: null, success: false }),
    row({ costUsd: null, elapsedMs: 2000 }),
  ]) {
    assert.equal(compareRuns(baseline, parsed([candidate])).observedGate, 'fail');
  }
  assert.equal(compareRuns(parsed([row({})]), parsed([row({ success: false })])).observedGate, 'fail');
  assert.equal(compareRuns(
    parsed([row({ success: false })]), parsed([row({ success: false, costUsd: 2 })]),
  ).observedGate, 'fail');
});

test('unpaired tasks are reported and block a pass; uncontrolled runs cannot be compared', () => {
  assert.throws(() => compareRuns(parsed([row({})]), parsed([row({ task: 'different' })])), /No non-canary task appears in both/);
  assert.throws(() => compareRuns(parsed([row({})]), parsed([row({ model: 'different' })])), /Uncontrolled model/);
  assert.throws(() => compareRuns(parsed([row({})]), parsed([row({ revision: 'different' })])), /Uncontrolled revision/);
  assert.throws(() => compareRuns(parsed([row({}), row({ trial: 2, control: 'changed' })]), parsed([row({})])),
    /Uncontrolled control/);
  assert.throws(() => compareRuns(parsed([row({ taskType: 'bugfix' })]), parsed([row({ taskType: 'feature' })])),
    /Inconsistent taskType/);
  const report = compareRuns(arm(many(11, [true])), arm(many(10, [true])));
  assert.equal(report.pairing.pairedTasks, 10);
  assert.deepEqual(report.pairing.baselineOnly, ['task-11']);
  assert.equal(report.pairing.unpairedCount, 1);
  assert.equal(report.baseline.tasks, 10);
  assert.equal(report.gates.allTasksPaired, null);
  assert.equal(report.observedGate, 'insufficient-data');
});

test('malformed, duplicate, empty, and negative measurements are rejected', () => {
  assert.throws(() => parseRuns(''), /Provide/);
  assert.throws(() => parseRuns('{bad'), /line 1/);
  assert.throws(() => parsed([row({}), row({})]), /Duplicate/);
  assert.throws(() => parsed([row({ costUsd: -1 })]), /nonnegative/);
  assert.throws(() => parsed([row({ elapsedMs: 0 })]), /positive/);
  assert.throws(() => parsed([row({ success: 'yes' })]), /boolean/);
  assert.throws(() => parsed([row({ inputTokens: 1.5 })]), /integer/);
  assert.throws(() => parsed([row({ testFilesChanged: 'no' })]), /testFilesChanged must be a boolean/);
  assert.throws(() => parsed([row({ taskType: '' })]), /taskType must be nonempty/);
  assert.throws(() => parsed([row({ trial: 0 })]), /trial must be a positive integer/);
  assert.throws(() => parsed([row({ guess: 1 })]), /unknown fields/);
});

test('omitted trial numbers follow file order per task and cannot be mixed with explicit ones', () => {
  const rows = parsed([
    row({ trial: undefined }), row({ trial: undefined, success: false }), row({ task: 'other', trial: undefined }),
  ]);
  assert.deepEqual(rows.map(item => [item.task, item.trial]), [['boundary-fix', 1], ['boundary-fix', 2], ['other', 1]]);
  assert.throws(() => parsed([row({}), row({ trial: undefined })]), /Mix of numbered and unnumbered/);
});

test('aggregate overflow is rejected rather than serialized as an unknown metric', () => {
  const rows = parsed([row({ costUsd: 1e308 }), row({ task: 'second', costUsd: 1e308 })]);
  assert.throws(() => compareRuns(rows, rows), /exceeds numeric limits/);
});

test('pass@k and pass^k use the unbiased per-task estimators with k set by the fewest trials', () => {
  close(passAtK(3, 1, 2), 2 / 3);
  close(passHatK(3, 1, 2), 0);
  close(passAtK(3, 2, 2), 1);
  close(passHatK(3, 2, 2), 1 / 3);
  close(passAtK(4, 2, 2), 5 / 6);
  close(passHatK(4, 2, 2), 1 / 6);
  close(passAtK(5, 0, 3), 0);
  close(passHatK(5, 5, 3), 1);
  close(passAtK(4, 1, 1), 0.25);
  assert.throws(() => passAtK(2, 1, 3), /pass@k needs/);
  const report = compareRuns(
    arm({ a: [true, false, false], b: [true, true, false] }),
    arm({ a: [true, true], b: [false, false] }),
  );
  assert.equal(report.k, 2);
  close(report.baseline.passAt1, 0.5);
  close(report.baseline.passAtK, (2 / 3 + 1) / 2);
  close(report.baseline.passHatK, (0 + 1 / 3) / 2);
  close(report.candidate.passAt1, 0.5);
  close(report.candidate.passAtK, 0.5);
  close(report.candidate.passHatK, 0.5);
  assert.equal(report.baseline.trials, 6);
  assert.equal(report.candidate.trials, 4);
});

test('the paired interval and verdict claim a direction only with enough tasks and a practical difference', () => {
  // Tasks 1-8 improve from 1/3 to 3/3; tasks 9-12 stay at 1/3.
  const improved = Object.fromEntries(Array.from({ length: 12 }, (_, index) =>
    [`task-${index + 1}`, index < 8 ? [true, true, true] : [true, false, false]]));
  const higher = compareRuns(arm(many(12, [true, false, false])), arm(improved));
  const difference = higher.successDifference;
  assert.equal(difference.pairedTasks, 12);
  close(difference.meanDifference, 4 / 9);
  const standardError = Math.sqrt((8 * (2 / 9) ** 2 + 4 * (4 / 9) ** 2) / 11 / 12);
  close(difference.standardError, standardError);
  close(difference.ci95[0], 4 / 9 - 1.959963984540054 * standardError);
  close(difference.ci95[1], 4 / 9 + 1.959963984540054 * standardError);
  assert.equal(difference.verdict, 'candidate higher');
  assert.equal(higher.power.approximate, true);
  const zSum = 1.959963984540054 + 0.8416212335729143;
  assert.equal(higher.power.pairedTasksNeeded, Math.ceil((zSum * difference.standardDeviation / 0.05) ** 2));

  const balanced = pairedDifference([...Array(5).fill(1 / 3), ...Array(5).fill(-1 / 3)]);
  assert.equal(balanced.verdict, 'not distinguishable');
  assert.ok(balanced.ci95[0] < 0 && balanced.ci95[1] > 0);

  const tiny = pairedDifference(Array(10).fill(0.02));
  assert.deepEqual(tiny.ci95, [0.02, 0.02]);
  assert.equal(tiny.verdict, 'not distinguishable');
  assert.match(tiny.verdictReason, /3 percentage points/);

  const few = pairedDifference(Array(5).fill(2 / 3));
  assert.equal(few.verdict, 'insufficient data');
  assert.equal(pairedDifference([1]).verdict, 'insufficient data');
  assert.equal(pairedDifference([1]).standardError, null);

  const lower = compareRuns(arm(many(10, [true, true, true])), arm(many(10, [false, false, true])));
  assert.equal(lower.successDifference.verdict, 'candidate lower');
  assert.equal(lower.observedGate, 'fail');
  assert.equal(lower.regressionCount, 10);
  assert.equal(lower.power.pairedTasksNeeded, null);
});

test('task-clustered standard errors differ from naive trial-level errors when trials repeat', () => {
  const report = compareRuns(
    arm({ a: [false, false, false], b: [false, false, false], c: [true, true, true], d: [true, true, true] }),
    arm({ a: [true, true, true], b: [false, false, false], c: [true, true, true], d: [true, true, true] }),
  );
  close(report.successDifference.meanDifference, 0.25);
  close(report.successDifference.standardError, 0.25);
  close(report.successDifference.naiveStandardError, Math.sqrt(0.25 / 12 + 0.1875 / 12));
  assert.notEqual(report.successDifference.standardError, report.successDifference.naiveStandardError);
});

test('results are stratified by task type and repository when present', () => {
  const spec = [['a', 'bugfix', 'api'], ['b', 'bugfix', 'web'], ['c', 'feature', 'api'], ['d', null, 'api']];
  const build = outcomes => parsed(spec.flatMap(([task, taskType, repo], index) =>
    trials(task, outcomes[index], { taskType, repo })));
  const report = compareRuns(
    build([[true, false], [false, false], [true, true], [true, true]]),
    build([[true, true], [true, false], [false, false], [true, true]]),
  );
  const types = Object.fromEntries(report.strata.taskType.groups.map(group => [group.value, group]));
  assert.equal(types.bugfix.pairedTasks, 2);
  close(types.bugfix.baselinePassAt1, 0.25);
  close(types.bugfix.candidatePassAt1, 0.75);
  close(types.bugfix.meanDifference, 0.5);
  assert.equal(types.feature.meanDifference, -1);
  assert.equal(types.feature.verdict, 'insufficient data');
  assert.equal(types.null.pairedTasks, 1);
  assert.equal(report.strata.taskType.groups[0].value, 'bugfix');
  const repos = Object.fromEntries(report.strata.repo.groups.map(group => [group.value, group]));
  assert.equal(repos.api.pairedTasks, 3);
  assert.equal(repos.web.pairedTasks, 1);
  assert.equal(report.strata.taskType.truncated, false);
  assert.equal(compareRuns(parsed([row({})]), parsed([row({})])).strata.repo, null);
});

test('test-file changes, held-out failures, and canary successes are regressions that outrank unknown cost', () => {
  const baseline = arm(many(10, [true, false, false]), { costUsd: null, testFilesChanged: false, heldOutPassed: true });
  const changedTests = compareRuns(baseline,
    arm(many(10, [true, true, false]), { costUsd: null, testFilesChanged: true, heldOutPassed: true }));
  assert.equal(changedTests.gates.successRate, true);
  assert.equal(changedTests.gates.meanCostPerTrial, null);
  assert.equal(changedTests.gates.testFileChangesAmongSuccesses, false);
  assert.equal(changedTests.candidate.testFileChangesAmongSuccesses, 20);
  assert.equal(changedTests.candidate.testFileChangeRateAmongSuccesses, 1);
  assert.equal(changedTests.observedGate, 'fail');

  const heldOut = compareRuns(baseline,
    arm(many(10, [true, true, false]), { costUsd: null, testFilesChanged: false, heldOutPassed: false }));
  assert.equal(heldOut.gates.heldOutPassRate, false);
  assert.equal(heldOut.baseline.heldOutPassRate, 1);
  assert.equal(heldOut.candidate.heldOutPassRate, 0);
  assert.equal(heldOut.heldOutDifference.meanDifference, -1);
  assert.equal(heldOut.observedGate, 'fail');

  const partial = compareRuns(baseline, arm(many(10, [true, true, false]), task =>
    ({ costUsd: null, testFilesChanged: task === 'task-1' ? null : false, heldOutPassed: true })));
  assert.equal(partial.gates.testFileChangesAmongSuccesses, null);
  assert.equal(partial.candidate.testFileChangesAmongSuccesses, null);
  assert.equal(partial.observedGate, 'insufficient-data');

  const canary = trials('impossible', [false, false, false], { canary: true });
  const cheated = compareRuns(parsed([...trials('real', [true]), ...canary]),
    parsed([...trials('real', [true]), ...trials('impossible', [false, true, false], { canary: true })]));
  assert.equal(cheated.gates.noCandidateCanarySuccess, false);
  assert.deepEqual(cheated.canaries, { tasks: 1, baseline: { trials: 3, successes: 0 }, candidate: { trials: 3, successes: 1 } });
  assert.equal(cheated.pairing.pairedTasks, 1);
  assert.equal(cheated.candidate.trials, 1);
  assert.equal(cheated.observedGate, 'fail');
  assert.throws(() => compareRuns(parsed(canary), parsed(canary)), /No non-canary task/);
});

test('submitted-but-failed runs are counted only when every failure records submission', () => {
  const report = compareRuns(
    parsed([row({ success: false, submitted: true }), row({ trial: 2, success: false, submitted: false }), row({ trial: 3 })]),
    parsed([row({ success: false, submitted: true }), row({ trial: 2, success: false }), row({ trial: 3 })]),
  );
  assert.equal(report.baseline.submittedButFailed, 1);
  assert.equal(report.candidate.submittedButFailed, null);
  const unrecorded = compareRuns(parsed([row({ success: false })]), parsed([row({ success: false })]));
  assert.equal(unrecorded.baseline.submittedButFailed, null);
  assert.ok(unrecorded.notRecorded.includes('submitted'));
});

test('token statistics are reported only when every run in the arm has them', () => {
  const report = compareRuns(
    parsed([row({ inputTokens: 100, outputTokens: 10 }), row({ trial: 2, inputTokens: 3000, outputTokens: 30 })]),
    parsed([row({ inputTokens: 100 }), row({ trial: 2, inputTokens: 200, outputTokens: 20 })]),
  );
  assert.deepEqual(report.baseline.inputTokens, { total: 3100, mean: 1550, median: 1550, min: 100, max: 3000 });
  assert.equal(report.candidate.outputTokens, null);
  assert.equal(report.baseline.medianElapsedMs, 1000);
  assert.equal(report.baseline.meanElapsedMs, 1000);
});

test('rows in the 0.4 format still parse and compare', () => {
  const legacy = '{"task":"pagination-boundary","trial":1,"revision":"immutable-revision","model":"same-selected-model",'
    + '"control":"same-tools-budget-and-environment","success":true,"elapsedMs":85000,'
    + '"costUsd":null,"inputTokens":null,"outputTokens":null}';
  const rows = parseRuns(`${legacy}\r\n${legacy.replace('"trial":1', '"trial":2').replace('85000', '90000')}\n`);
  assert.equal(rows.length, 2);
  const report = compareRuns(rows, rows);
  assert.equal(report.k, 2);
  assert.equal(report.baseline.passAt1, 1);
  assert.equal(report.baseline.costUsd, null);
  assert.equal(report.baseline.medianElapsedMs, 87500);
  assert.equal(report.successDifference.meanDifference, 0);
  assert.equal(report.observedGate, 'insufficient-data');
  assert.equal(report.strata.taskType, null);
  for (const field of ['taskType', 'repo', 'testFilesChanged', 'heldOutPassed', 'canary']) {
    assert.ok(report.notRecorded.includes(field), field);
  }
  assert.equal('testFileChangesAmongSuccesses' in report.gates, false);
});

test('the comparison script keeps its two-file CLI and JSON output with gate-based exit codes', () => {
  const script = fileURLToPath(new URL('../scripts/compare-runs.mjs', import.meta.url));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'leanloop-metrics-'));
  try {
    const write = (name, rows) => {
      const file = path.join(directory, name);
      fs.writeFileSync(file, rows.map(value => JSON.stringify(value)).join('\n'));
      return file;
    };
    const rows = Object.entries(many(10, [true, true, true])).flatMap(([task, outcomes]) => trials(task, outcomes));
    const baseline = write('baseline.jsonl', rows);
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    const passed = run(baseline, write('candidate.jsonl', rows.map(item => ({ ...item, elapsedMs: 900 }))));
    assert.equal(passed.status, 0);
    assert.equal(JSON.parse(passed.stdout).observedGate, 'pass');
    const failed = run(baseline, write('worse.jsonl', rows.map(item => ({ ...item, success: item.trial !== 1 }))));
    assert.equal(failed.status, 1);
    assert.equal(JSON.parse(failed.stdout).observedGate, 'fail');
    const usage = run(baseline);
    assert.equal(usage.status, 2);
    assert.match(JSON.parse(usage.stderr).error, /Usage/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
