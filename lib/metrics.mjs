import { requireThat, text } from '../skills/leanloop/scripts/lib/io.mjs';

const FIELDS = ['task', 'trial', 'revision', 'model', 'control', 'success', 'elapsedMs', 'costUsd', 'inputTokens', 'outputTokens'];

function validate(record) {
  requireThat(record && typeof record === 'object' && !Array.isArray(record), 'Each measurement must be an object.');
  requireThat(Object.keys(record).every(key => FIELDS.includes(key)), 'Measurement contains unknown fields.');
  for (const field of ['task', 'revision', 'model', 'control']) text(record[field], field, 200);
  requireThat(Number.isSafeInteger(record.trial) && record.trial >= 1, 'trial must be a positive integer.');
  requireThat(typeof record.success === 'boolean', 'success must be a boolean backed by acceptance checks.');
  requireThat(Number.isFinite(record.elapsedMs) && record.elapsedMs > 0, 'elapsedMs must be finite and positive.');
  for (const field of ['costUsd', 'inputTokens', 'outputTokens']) {
    const value = record[field];
    if (value === undefined || value === null) continue;
    requireThat(Number.isFinite(value) && value >= 0, `${field} must be nonnegative or null, never an estimate disguised as a measurement.`);
    if (field !== 'costUsd') requireThat(Number.isSafeInteger(value), `${field} must be an integer.`);
  }
  return record;
}

export function parseRuns(contents) {
  requireThat(Buffer.byteLength(contents) <= 2 * 1024 * 1024, 'Measurements exceed 2 MiB.');
  const lines = contents.split(/\r?\n/).filter(line => line.trim());
  requireThat(lines.length > 0 && lines.length <= 10000, 'Provide 1-10,000 measurement rows.');
  const records = lines.map((line, index) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid measurement JSON at line ${index + 1}: ${error.message}`);
    }
    return validate(record);
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

function total(records, field) {
  if (!records.every(record => Number.isFinite(record[field]))) return null;
  const sum = records.reduce((value, record) => value + record[field], 0);
  requireThat(Number.isFinite(sum), `Aggregate ${field} exceeds numeric limits.`);
  return sum;
}

export function compareRuns(baseline, candidate) {
  requireThat(baseline.length === candidate.length && baseline.length > 0, 'Both variants must contain the same nonempty task/trial set.');
  const byKey = new Map(candidate.map(record => [JSON.stringify([record.task, record.trial]), record]));
  const pairs = baseline.map(before => {
    const after = byKey.get(JSON.stringify([before.task, before.trial]));
    requireThat(after, `Missing candidate pair: ${before.task}/${before.trial}`);
    for (const field of ['revision', 'model', 'control']) {
      requireThat(before[field] === after[field], `Uncontrolled ${field} difference for ${before.task}/${before.trial}.`);
    }
    return { before, after };
  });
  const solved = pairs.filter(pair => pair.before.success && pair.after.success);
  const regressions = pairs.filter(pair => pair.before.success && !pair.after.success)
    .map(pair => ({ task: pair.before.task, trial: pair.before.trial }));
  const summary = records => ({
    runs: records.length,
    successful: records.filter(record => record.success).length,
    medianElapsedMs: median(records.map(record => record.elapsedMs)),
    costUsd: total(records, 'costUsd'),
    inputTokens: total(records, 'inputTokens'),
    outputTokens: total(records, 'outputTokens'),
  });
  const before = summary(baseline);
  const after = summary(candidate);
  const baselineSolved = median(solved.map(pair => pair.before.elapsedMs));
  const candidateSolved = median(solved.map(pair => pair.after.elapsedMs));
  const comparableCost = before.costUsd !== null && after.costUsd !== null;
  const gates = {
    noRegressions: regressions.length === 0,
    successCount: after.successful >= before.successful,
    commonSuccessLatency: solved.length ? candidateSolved <= baselineSolved : null,
    totalCost: comparableCost ? after.costUsd <= before.costUsd : null,
  };
  return {
    baseline: before, candidate: after,
    commonSuccessPairs: solved.length,
    commonSuccessMedianElapsedMs: { baseline: baselineSolved, candidate: candidateSolved },
    regressionCount: regressions.length,
    regressions: regressions.slice(0, 20),
    regressionListTruncated: regressions.length > 20,
    gates,
    observedGate: Object.values(gates).includes(false) ? 'fail' :
      Object.values(gates).includes(null) ? 'insufficient-data' : 'pass',
    note: 'Descriptive paired measurements, not statistical significance or a guarantee. Missing metrics are null, not zero. Review difficult-task failures and repeated trials before adopting.',
  };
}
