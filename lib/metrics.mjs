import { requireThat, text } from './io.mjs';

const FIELDS = [
  'task', 'trial', 'revision', 'model', 'control', 'success', 'elapsedMs', 'costUsd', 'inputTokens', 'outputTokens',
  'taskType', 'repo', 'submitted', 'testFilesChanged', 'heldOutPassed', 'canary',
];
const FLAGS = ['submitted', 'testFilesChanged', 'heldOutPassed', 'canary'];
const OPTIONAL = ['taskType', 'repo', 'submitted', 'testFilesChanged', 'heldOutPassed', 'costUsd', 'inputTokens', 'outputTokens'];
export const MIN_PAIRED_TASKS = 10;
export const PRACTICAL_DIFFERENCE = 0.03;
const POWER_DIFFERENCE = 0.05;
const Z_95 = 1.959963984540054;
const Z_POWER_80 = 0.8416212335729143;
const EPSILON = 1e-9;
const LIST_LIMIT = 20;
const STRATA_LIMIT = 50;

const absent = value => value === undefined || value === null;

function validate(record) {
  requireThat(record && typeof record === 'object' && !Array.isArray(record), 'Each measurement must be an object.');
  requireThat(Object.keys(record).every(key => FIELDS.includes(key)), 'Measurement contains unknown fields.');
  for (const field of ['task', 'revision', 'model', 'control']) text(record[field], field, 200);
  for (const field of ['taskType', 'repo']) if (!absent(record[field])) text(record[field], field, 200);
  requireThat(absent(record.trial) || (Number.isSafeInteger(record.trial) && record.trial >= 1),
    'trial must be a positive integer.');
  requireThat(typeof record.success === 'boolean', 'success must be a boolean backed by acceptance checks.');
  for (const field of FLAGS) {
    requireThat(absent(record[field]) || typeof record[field] === 'boolean', `${field} must be a boolean, or null when unknown.`);
  }
  requireThat(Number.isFinite(record.elapsedMs) && record.elapsedMs > 0, 'elapsedMs must be finite and positive.');
  for (const field of ['costUsd', 'inputTokens', 'outputTokens']) {
    const value = record[field];
    if (absent(value)) continue;
    requireThat(Number.isFinite(value) && value >= 0, `${field} must be nonnegative or null, never an estimate disguised as a measurement.`);
    if (field !== 'costUsd') requireThat(Number.isSafeInteger(value), `${field} must be an integer.`);
  }
  return record;
}

export function parseRuns(contents) {
  requireThat(Buffer.byteLength(contents) <= 2 * 1024 * 1024, 'Measurements exceed 2 MiB.');
  const lines = contents.split(/\r?\n/).filter(line => line.trim());
  requireThat(lines.length > 0 && lines.length <= 10000, 'Provide 1-10,000 measurement rows.');
  const numbering = new Map();
  const records = lines.map((line, index) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid measurement JSON at line ${index + 1}: ${error.message}`);
    }
    validate(record);
    // Trials of one task are exchangeable samples; omitted numbers follow file order within that task.
    const explicit = !absent(record.trial);
    const seen = numbering.get(record.task) ?? { explicit, count: 0 };
    requireThat(seen.explicit === explicit, `Mix of numbered and unnumbered trials for task ${record.task}.`);
    seen.count += 1;
    numbering.set(record.task, seen);
    return explicit ? record : { ...record, trial: seen.count };
  });
  const keys = records.map(record => JSON.stringify([record.task, record.trial]));
  requireThat(new Set(keys).size === keys.length, 'Duplicate task/trial measurements.');
  return records;
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : ordered[middle - 1] / 2 + ordered[middle] / 2;
}

function sum(values, label) {
  const result = values.reduce((value, item) => value + item, 0);
  requireThat(Number.isFinite(result), `Aggregate ${label} exceeds numeric limits.`);
  return result;
}

const mean = (values, label) => (values.length ? sum(values, label) / values.length : null);
// Display rounding only; gates use unrounded values. `|| 0` avoids serializing negative zero.
const round = value => (absent(value) ? null : Number(value.toPrecision(10)));
const share = value => (absent(value) ? null : Math.round(value * 1e4) / 1e4 || 0);
const successes = rows => rows.filter(row => row.success).length;
const rate = rows => successes(rows) / rows.length;
const flagRate = (rows, field) => rows.filter(row => row[field]).length / rows.length;
const known = (rows, field) => rows.every(row => typeof row[field] === 'boolean');

function total(records, field) {
  if (!records.every(record => Number.isFinite(record[field]))) return null;
  return sum(records.map(record => record[field]), field);
}

function spread(records, field) {
  if (!records.every(record => Number.isFinite(record[field]))) return null;
  const values = records.map(record => record[field]);
  return {
    total: sum(values, field), mean: round(mean(values, field)), median: median(values),
    min: values.reduce((low, value) => Math.min(low, value)), max: values.reduce((high, value) => Math.max(high, value)),
  };
}

function checkSample(trials, solved, k) {
  requireThat([trials, solved, k].every(Number.isSafeInteger) && k >= 1 && k <= trials && solved >= 0 && solved <= trials,
    'pass@k needs 1 <= k <= trials and 0 <= successes <= trials.');
}

// Unbiased estimate that at least one of k trials, drawn without replacement from the recorded ones, succeeds.
export function passAtK(trials, solved, k) {
  checkSample(trials, solved, k);
  if (trials - solved < k) return 1;
  let allFail = 1;
  for (let index = 0; index < k; index += 1) allFail *= (trials - solved - index) / (trials - index);
  return 1 - allFail;
}

// pass^k: the estimated chance that all k drawn trials succeed.
export function passHatK(trials, solved, k) {
  checkSample(trials, solved, k);
  if (solved < k) return 0;
  let allPass = 1;
  for (let index = 0; index < k; index += 1) allPass *= (solved - index) / (trials - index);
  return allPass;
}

// Per-task differences in success rate; each task is one cluster, so this is the task-clustered paired estimate.
export function pairedDifference(differences) {
  const count = differences.length;
  const meanDifference = mean(differences, 'difference');
  const spreadValue = count >= 2
    ? Math.sqrt(differences.reduce((value, item) => value + (item - meanDifference) ** 2, 0) / (count - 1)) : null;
  // Identical differences can leave floating-point residue; that is no observed variation.
  const deviation = spreadValue !== null && spreadValue < EPSILON ? 0 : spreadValue;
  const standardError = deviation === null ? null : deviation / Math.sqrt(count);
  const ci95 = standardError === null ? null
    : [Math.max(-1, meanDifference - Z_95 * standardError), Math.min(1, meanDifference + Z_95 * standardError)];
  let verdict = 'insufficient data';
  let verdictReason = 'At least 2 paired tasks are needed to estimate a standard error.';
  if (ci95 && ci95[0] <= EPSILON && ci95[1] >= -EPSILON) {
    verdict = 'not distinguishable';
    verdictReason = 'The 95% interval includes 0.';
  } else if (ci95 && Math.abs(meanDifference) < PRACTICAL_DIFFERENCE) {
    verdict = 'not distinguishable';
    verdictReason = 'The difference is smaller than 3 percentage points.';
  } else if (ci95 && count < MIN_PAIRED_TASKS) {
    verdictReason = `Fewer than ${MIN_PAIRED_TASKS} paired tasks; no direction is claimed.`;
  } else if (ci95) {
    verdict = meanDifference > 0 ? 'candidate higher' : 'candidate lower';
    verdictReason = 'The 95% interval excludes 0 and the difference is at least 3 percentage points.';
  }
  return {
    pairedTasks: count, meanDifference: share(meanDifference), standardDeviation: share(deviation),
    standardError: share(standardError), ci95: ci95 && ci95.map(share), verdict, verdictReason,
  };
}

function powerNote(deviation) {
  const needed = deviation ? Math.max(2, Math.ceil(((Z_95 + Z_POWER_80) * deviation / POWER_DIFFERENCE) ** 2)) : null;
  return {
    approximate: true, targetDifference: POWER_DIFFERENCE, alpha: 0.05, power: 0.8,
    observedStandardDeviation: deviation, pairedTasksNeeded: needed,
    note: needed === null ? 'Needs at least 2 paired tasks whose differences vary.'
      : 'Normal approximation from the observed SD of per-task differences at the current trials per task.',
  };
}

function byTask(records) {
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.task)) groups.set(record.task, []);
    groups.get(record.task).push(record);
  }
  return groups;
}

function describeTask(task, rows) {
  for (const field of ['revision', 'model', 'control']) {
    requireThat(rows.every(row => row[field] === rows[0][field]), `Uncontrolled ${field} difference for ${task}.`);
  }
  const attribute = field => {
    const values = [...new Set(rows.map(row => row[field]).filter(value => !absent(value)))];
    requireThat(values.length <= 1, `Inconsistent ${field} for ${task}.`);
    return values.length ? values[0] : null;
  };
  return { task, taskType: attribute('taskType'), repo: attribute('repo'), canary: attribute('canary') === true };
}

function summarize(tasks, side, k, recorded) {
  const rows = tasks.flatMap(item => item[side]);
  const solved = rows.filter(row => row.success);
  const failed = rows.filter(row => !row.success);
  const costUsd = total(rows, 'costUsd');
  const testFileChanges = recorded('testFilesChanged') && known(solved, 'testFilesChanged')
    ? solved.filter(row => row.testFilesChanged).length : null;
  const heldOut = tasks.filter(item => known(item[side], 'heldOutPassed'));
  const perTask = estimate => share(mean(tasks.map(item => estimate(item[side].length, successes(item[side]), k)), 'rate'));
  return {
    tasks: tasks.length,
    trials: rows.length,
    successful: solved.length,
    passAt1: share(mean(tasks.map(item => rate(item[side])), 'rate')),
    passAtK: perTask(passAtK),
    passHatK: perTask(passHatK),
    submittedButFailed: recorded('submitted') && known(failed, 'submitted')
      ? failed.filter(row => row.submitted).length : null,
    testFileChangesAmongSuccesses: testFileChanges,
    testFileChangeRateAmongSuccesses: testFileChanges === null || !solved.length ? null : share(testFileChanges / solved.length),
    heldOutTasks: heldOut.length,
    heldOutPassRate: heldOut.length ? share(mean(heldOut.map(item => flagRate(item[side], 'heldOutPassed')), 'rate')) : null,
    medianElapsedMs: median(rows.map(row => row.elapsedMs)),
    meanElapsedMs: round(mean(rows.map(row => row.elapsedMs), 'elapsedMs')),
    costUsd: round(costUsd),
    meanCostPerTrialUsd: costUsd === null ? null
      : round(mean(tasks.map(item => mean(item[side].map(row => row.costUsd), 'costUsd')), 'costUsd')),
    costPerSuccessUsd: costUsd === null || !solved.length ? null : round(costUsd / solved.length),
    inputTokens: spread(rows, 'inputTokens'),
    outputTokens: spread(rows, 'outputTokens'),
  };
}

function testFileGate(before, after) {
  if (before.testFileChangesAmongSuccesses === null || after.testFileChangesAmongSuccesses === null) return null;
  if (after.testFileChangesAmongSuccesses === 0) return true;
  if (!before.successful) return false;
  // Compare the rates among successes exactly by cross-multiplying counts.
  return after.testFileChangesAmongSuccesses * before.successful <= before.testFileChangesAmongSuccesses * after.successful;
}

const change = item => rate(item.candidate) - rate(item.baseline);

function stratify(tasks, field) {
  if (tasks.every(item => item[field] === null)) return null;
  const groups = new Map();
  for (const item of tasks) {
    if (!groups.has(item[field])) groups.set(item[field], []);
    groups.get(item[field]).push(item);
  }
  const order = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  const ordered = [...groups].sort(([leftValue, left], [rightValue, right]) =>
    right.length - left.length || order(leftValue ?? '', rightValue ?? ''));
  return {
    groups: ordered.slice(0, STRATA_LIMIT).map(([value, items]) => ({
      value,
      baselinePassAt1: share(mean(items.map(item => rate(item.baseline)), 'rate')),
      candidatePassAt1: share(mean(items.map(item => rate(item.candidate)), 'rate')),
      ...pairedDifference(items.map(change)),
    })),
    truncated: ordered.length > STRATA_LIMIT,
  };
}

export function compareRuns(baseline, candidate) {
  requireThat(Array.isArray(baseline) && Array.isArray(candidate) && baseline.length > 0 && candidate.length > 0,
    'Both variants must contain measurements.');
  const before = byTask(baseline);
  const after = byTask(candidate);
  const paired = [];
  const baselineOnly = [];
  const candidateOnly = [];
  for (const [task, rows] of before) {
    const other = after.get(task);
    if (other) paired.push({ ...describeTask(task, [...rows, ...other]), baseline: rows, candidate: other });
    else baselineOnly.push(describeTask(task, rows).task);
  }
  for (const [task, rows] of after) if (!before.has(task)) candidateOnly.push(describeTask(task, rows).task);
  const tasks = paired.filter(item => !item.canary);
  const canaries = paired.filter(item => item.canary);
  requireThat(tasks.length > 0, 'No non-canary task appears in both variants; nothing can be paired.');

  const analyzed = tasks.flatMap(item => [...item.baseline, ...item.candidate]);
  const recorded = field => analyzed.some(row => !absent(row[field]));
  const k = tasks.reduce((low, item) => Math.min(low, item.baseline.length, item.candidate.length), Infinity);
  const summary = {
    baseline: summarize(tasks, 'baseline', k, recorded), candidate: summarize(tasks, 'candidate', k, recorded),
  };

  const successChanges = tasks.map(change);
  const successDifference = pairedDifference(successChanges);
  // Trial-level binomial error that ignores task clustering and pairing; reported only for contrast.
  const pooled = side => {
    const rows = tasks.flatMap(item => item[side]);
    return rate(rows) * (1 - rate(rows)) / rows.length;
  };
  const gates = { successRate: mean(successChanges, 'rate') >= -EPSILON };
  if (recorded('testFilesChanged')) gates.testFileChangesAmongSuccesses = testFileGate(summary.baseline, summary.candidate);
  let heldOutDifference = null;
  const heldOutTasks = tasks.filter(item => [...item.baseline, ...item.candidate].some(row => !absent(row.heldOutPassed)));
  if (heldOutTasks.length) {
    const complete = heldOutTasks.every(item => known(item.baseline, 'heldOutPassed') && known(item.candidate, 'heldOutPassed'));
    const heldOutChanges = complete
      ? heldOutTasks.map(item => flagRate(item.candidate, 'heldOutPassed') - flagRate(item.baseline, 'heldOutPassed')) : null;
    heldOutDifference = heldOutChanges && pairedDifference(heldOutChanges);
    gates.heldOutPassRate = heldOutChanges ? mean(heldOutChanges, 'rate') >= -EPSILON : null;
  }
  if (canaries.length) gates.noCandidateCanarySuccess = canaries.every(item => successes(item.candidate) === 0);

  const common = tasks.filter(item => successes(item.baseline) > 0 && successes(item.candidate) > 0);
  const solvedMedian = side =>
    median(common.map(item => median(item[side].filter(row => row.success).map(row => row.elapsedMs))));
  const baselineSolved = solvedMedian('baseline');
  const candidateSolved = solvedMedian('candidate');
  const beforeCost = summary.baseline.meanCostPerTrialUsd;
  const afterCost = summary.candidate.meanCostPerTrialUsd;
  gates.commonSuccessLatency = common.length ? candidateSolved <= baselineSolved : null;
  gates.meanCostPerTrial = beforeCost !== null && afterCost !== null
    ? afterCost <= beforeCost + EPSILON * Math.max(1, beforeCost) : null;
  gates.minimumPairedTasks = tasks.length >= MIN_PAIRED_TASKS ? true : null;
  gates.allTasksPaired = baselineOnly.length || candidateOnly.length ? null : true;

  const regressions = tasks.filter(item => change(item) < -EPSILON).sort((left, right) => change(left) - change(right))
    .map(item => ({
      task: item.task, baselineSuccesses: successes(item.baseline), baselineTrials: item.baseline.length,
      candidateSuccesses: successes(item.candidate), candidateTrials: item.candidate.length,
    }));
  const notRecorded = OPTIONAL.filter(field => !recorded(field));
  if (!canaries.length) notRecorded.push('canary');
  const warnings = [];
  if (k < 3) warnings.push(`k = ${k}: run every task at least 3 times per arm; single runs shift by several points.`);
  if (tasks.length < MIN_PAIRED_TASKS) {
    warnings.push(`${tasks.length} paired task(s); at least ${MIN_PAIRED_TASKS} are needed before a pass or a direction `
      + 'is reported.');
  }
  if (baselineOnly.length || candidateOnly.length) {
    warnings.push(`${baselineOnly.length + candidateOnly.length} task(s) appear in only one variant and are excluded.`);
  }
  const canarySide = side => ({
    trials: canaries.reduce((count, item) => count + item[side].length, 0),
    successes: canaries.reduce((count, item) => count + successes(item[side]), 0),
  });
  const values = Object.values(gates);
  return {
    k,
    pairing: {
      pairedTasks: tasks.length, canaryTasks: canaries.length,
      baselineOnly: baselineOnly.slice(0, LIST_LIMIT), candidateOnly: candidateOnly.slice(0, LIST_LIMIT),
      unpairedCount: baselineOnly.length + candidateOnly.length,
      unpairedListTruncated: baselineOnly.length > LIST_LIMIT || candidateOnly.length > LIST_LIMIT,
    },
    baseline: summary.baseline,
    candidate: summary.candidate,
    successDifference: { ...successDifference, naiveStandardError: share(Math.sqrt(pooled('baseline') + pooled('candidate'))) },
    power: powerNote(successDifference.standardDeviation),
    heldOutDifference,
    strata: { taskType: stratify(tasks, 'taskType'), repo: stratify(tasks, 'repo') },
    canaries: canaries.length
      ? { tasks: canaries.length, baseline: canarySide('baseline'), candidate: canarySide('candidate') } : null,
    commonSuccessTasks: common.length,
    commonSuccessMedianElapsedMs: { baseline: baselineSolved, candidate: candidateSolved },
    regressionCount: regressions.length,
    regressions: regressions.slice(0, LIST_LIMIT),
    regressionListTruncated: regressions.length > LIST_LIMIT,
    improvementCount: tasks.filter(item => change(item) > EPSILON).length,
    gates,
    observedGate: values.includes(false) ? 'fail' : values.includes(null) ? 'insufficient-data' : 'pass',
    notRecorded,
    warnings,
    note: 'Rates weight each task once; differences are candidate minus baseline. Gates compare observed point estimates, '
      + 'so any observed quality drop fails. The verdict uses a task-clustered normal-approximation 95% interval and needs '
      + `${MIN_PAIRED_TASKS}+ paired tasks for a direction; naiveStandardError ignores clustering and pairing `
      + 'and is shown for contrast. Missing metrics are null, not zero. Approximate and specific to these tasks, '
      + 'not proof of general superiority.',
  };
}
