import assert from 'node:assert/strict';
import test from 'node:test';
import { compareRuns, parseRuns } from '../lib/metrics.mjs';

const row = overrides => ({
  task: 'boundary-fix', trial: 1, revision: 'fixture-v1', model: 'same-model',
  control: 'same-tools-and-budget', success: true, elapsedMs: 1000, costUsd: 1, ...overrides,
});
const parsed = rows => parseRuns(rows.map(value => JSON.stringify(value)).join('\n'));

test('paired improvements pass the descriptive gate without inventing token measurements', () => {
  const report = compareRuns(parsed([row({})]), parsed([row({ elapsedMs: 800, costUsd: 0.5 })]));
  assert.equal(report.observedGate, 'pass');
  assert.equal(report.baseline.inputTokens, null);
  assert.equal(report.commonSuccessPairs, 1);
});

test('missing costs are unknown, not a free candidate or an improvement claim', () => {
  const report = compareRuns(parsed([row({})]), parsed([row({ costUsd: null })]));
  assert.equal(report.candidate.costUsd, null);
  assert.equal(report.observedGate, 'insufficient-data');
});

test('success regressions cannot be hidden by faster failures', () => {
  const before = parsed([row({}), row({ task: 'second' })]);
  const after = parsed([row({ elapsedMs: 1, success: false }), row({ task: 'second', elapsedMs: 500 })]);
  const report = compareRuns(before, after);
  assert.equal(report.regressionCount, 1);
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

test('unpaired or uncontrolled runs cannot be compared', () => {
  assert.throws(() => compareRuns(parsed([row({})]), parsed([row({ task: 'different' })])), /Missing candidate/);
  assert.throws(() => compareRuns(parsed([row({})]), parsed([row({ model: 'different' })])), /Uncontrolled model/);
  assert.throws(() => compareRuns(parsed([row({})]), parsed([row({ revision: 'different' })])), /Uncontrolled revision/);
});

test('malformed, duplicate, empty, and negative measurements are rejected', () => {
  assert.throws(() => parseRuns(''), /Provide/);
  assert.throws(() => parseRuns('{bad'), /line 1/);
  assert.throws(() => parsed([row({}), row({})]), /Duplicate/);
  assert.throws(() => parsed([row({ costUsd: -1 })]), /nonnegative/);
  assert.throws(() => parsed([row({ elapsedMs: 0 })]), /positive/);
  assert.throws(() => parsed([row({ success: 'yes' })]), /boolean/);
  assert.throws(() => parsed([row({ inputTokens: 1.5 })]), /integer/);
});

test('aggregate overflow is rejected rather than serialized as an unknown metric', () => {
  const rows = parsed([row({ costUsd: 1e308 }), row({ task: 'second', costUsd: 1e308 })]);
  assert.throws(() => compareRuns(rows, rows), /exceeds numeric limits/);
});
