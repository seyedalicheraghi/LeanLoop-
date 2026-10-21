import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  cancel, checkpoint, extendBudget, finish, recordProof, recordReview, startTask, status, verify,
} from '../lib/tasks.mjs';
import { atomicJson, readJson, withLock } from '../lib/io.mjs';
import { fingerprint } from '../lib/git.mjs';
import { fixture, commit, git, cli, temporary } from './helpers.mjs';

const request = { goal: 'Preserve the answer', criteria: ['The answer is 42'], scope: ['src'] };

test('complete lifecycle requires actual checks and criterion evidence', async t => {
  const root = await fixture(t);
  await startTask(root, request);
  await assert.rejects(finish(root), /Verification is missing/);
  const checked = await verify(root);
  assert.equal(checked.ok, true);
  await assert.rejects(finish(root), /acceptance criterion/);
  await recordProof(root, 1, 'Observed exported answer in src/app.mjs; fixture check passed.');
  const done = await finish(root);
  assert.equal(done.phase, 'done');
  assert.equal(status(root).verification.fresh, true);
  assert.equal(fs.existsSync(path.join(root, '.leanloop/lock.json')), false);
});

test('no checks, failed checks, and a missing executable cannot be completed', async t => {
  for (const checks of [[], [{ name: 'test', command: [process.execPath, '-e', 'process.exit(7)'] }],
    [{ name: 'test', command: ['nonexistent-leanloop-executable'] }]]) {
    const root = await fixture(t, checks);
    await startTask(root, request);
    if (!checks.length) await assert.rejects(verify(root), /No checks configured/);
    else {
      const checked = await verify(root);
      assert.equal(checked.ok, false);
      assert.equal(checked.results[0].ok, false);
    }
    await recordProof(root, 1, 'A claimed acceptance result is insufficient on its own.');
    await assert.rejects(finish(root));
  }
});

test('source changes invalidate checks, acceptance, and review', async t => {
  const root = await fixture(t);
  commit(root);
  await startTask(root, { ...request, risk: 'high' });
  await verify(root);
  await recordProof(root, 1, 'Answer verified.');
  await recordReview(root, 'reviewer', 'approve', 'Final code and check evidence reviewed.');
  fs.writeFileSync(path.join(root, 'src/app.mjs'), 'export const answer = 43;\n');
  assert.equal(status(root).verification.fresh, false);
  await assert.rejects(finish(root), /stale/);
  await verify(root);
  await assert.rejects(finish(root), /acceptance criterion/);
  await recordProof(root, 1, 'New evidence after inspecting the changed behavior.');
  await assert.rejects(finish(root), /current approving review/);
});

test('staged changes invalidate evidence even when the worktree matches HEAD', async t => {
  const root = await fixture(t);
  commit(root);
  await startTask(root, request);
  await verify(root);
  await recordProof(root, 1, 'The checked worktree exports 42.');
  const file = path.join(root, 'src/app.mjs');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, 'export const answer = 0;\n');
  git(root, ['add', 'src/app.mjs']);
  fs.writeFileSync(file, original);
  assert.equal(status(root).verification.fresh, false);
  await assert.rejects(finish(root), error => error.code === 'STALE_EVIDENCE');
  git(root, ['add', 'src/app.mjs']);
  assert.equal(status(root).verification.fresh, true);
  assert.equal((await finish(root)).phase, 'done');
});

test('untracked files and permission changes invalidate a fingerprint', async t => {
  const root = await fixture(t);
  const before = fingerprint(root);
  fs.writeFileSync(path.join(root, 'new.mjs'), '42;\n', { mode: 0o644 });
  const added = fingerprint(root);
  assert.notEqual(added, before);
  // Windows has no execute bit; chmod there only toggles read-only.
  if (process.platform === 'win32') return;
  fs.chmodSync(path.join(root, 'new.mjs'), 0o755);
  assert.notEqual(fingerprint(root), added);
});

test('checks that modify source invalidate their own result', async t => {
  const root = await fixture(t, [{
    name: 'mutating', command: [process.execPath, '-e', "require('fs').writeFileSync('src/app.mjs', 'changed');"],
  }]);
  await startTask(root, request);
  const result = await verify(root);
  assert.equal(result.ok, false);
  assert.equal(result.sourceStable, false);
  await assert.rejects(finish(root), /Verification is missing/);
});

test('high-risk work requires a distinct approving reviewer', async t => {
  const root = await fixture(t);
  await startTask(root, { ...request, risk: 'high' });
  await verify(root);
  await recordProof(root, 1, 'Observed behavior and tests.');
  await assert.rejects(recordReview(root, 'PRIMARY', 'approve', 'Self review'), /differ/);
  await assert.rejects(finish(root), /approving review/);
  await recordReview(root, 'independent-reviewer', 'request-changes', 'Missing boundary case.');
  await assert.rejects(finish(root), /approving review/);
  await recordReview(root, 'independent-reviewer', 'approve', 'Boundary case evidence inspected.');
  assert.equal((await finish(root)).phase, 'done');
});

test('targeted checks accumulate only for the same source; unknown selectors fail', async t => {
  const root = await fixture(t, [
    { name: 'unit', command: [process.execPath, '-e', 'process.exit(0)'] },
    { name: 'integration', command: [process.execPath, '-e', 'process.exit(0)'] },
  ]);
  await startTask(root, request);
  await assert.rejects(verify(root, ['unknown']), /Unknown/);
  assert.equal(status(root).attempts, 0);
  assert.equal((await verify(root, ['unit'])).ok, true);
  await recordProof(root, 1, 'Observed answer.');
  await assert.rejects(finish(root), /configured checks/);
  assert.equal((await verify(root, ['integration'])).ok, true);
  assert.equal((await finish(root)).phase, 'done');
});

test('attempt budgets stop retries and require a recorded extension', async t => {
  const root = await fixture(t, [{ name: 'fail', command: [process.execPath, '-e', 'process.exit(1)'] }]);
  await startTask(root, request);
  // Each retry runs against a changed source; runs on the unchanged starting source are free (next test).
  const retry = attempt => fs.writeFileSync(path.join(root, 'src/app.mjs'), `export const answer = ${attempt};\n`);
  for (let attempt = 0; attempt < 3; attempt++) {
    retry(attempt);
    assert.equal((await verify(root)).ok, false);
  }
  await assert.rejects(verify(root), /budget exhausted/);
  await assert.rejects(extendBudget(root, 1, ''), /nonempty/);
  assert.equal((await extendBudget(root, 1, 'A new regression test isolates a different hypothesis.')).attemptLimit, 4);
  assert.equal((await verify(root)).attempts, 4);
});

test('the first two checks on the unchanged starting source are free; later reruns there spend attempts', async t => {
  const root = await fixture(t, [{ name: 'fail', command: [process.execPath, '-e', 'process.exit(1)'] }]);
  await startTask(root, request);
  for (let run = 0; run < 2; run++) {
    const red = await verify(root);
    assert.equal(red.ok, false);
    assert.equal(red.attemptCharged, false);
    assert.equal(red.attempts, 0);
  }
  // Rerunning the unchanged source until it passes is a retry, so the budget still stops it.
  for (let run = 1; run <= 3; run++) {
    const rerun = await verify(root);
    assert.equal(rerun.attemptCharged, true);
    assert.equal(rerun.attempts, run);
  }
  await assert.rejects(verify(root), error => error.code === 'BUDGET_EXHAUSTED');
  assert.equal(readJson(root, '.leanloop/task.json').history.length, 5);
});

test('a source change is charged, and returning to the starting source does not reset the free runs', async t => {
  const root = await fixture(t, [{ name: 'fail', command: [process.execPath, '-e', 'process.exit(1)'] }]);
  await startTask(root, request);
  assert.equal((await verify(root)).attemptCharged, false);
  fs.writeFileSync(path.join(root, 'src/app.mjs'), 'export const answer = 43;\n');
  const changed = await verify(root);
  assert.equal(changed.attemptCharged, true);
  assert.equal(changed.attempts, 1);
  fs.writeFileSync(path.join(root, 'src/app.mjs'), 'export const answer = 42;\n');
  assert.equal((await verify(root)).attemptCharged, false);
  assert.equal((await verify(root)).attemptCharged, true);
});

test('a check that fails and then passes on the same final source needs review before finish', async t => {
  // The check fails on its first run and passes afterwards, without any source change: a flaky check.
  const marker = path.join(temporary(t), 'ran-once');
  const flaky = `const fs = require('fs'); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, ''); process.exit(1); }`;
  const root = await fixture(t, [{ name: 'flaky', command: [process.execPath, '-e', flaky] }]);
  commit(root);
  await startTask(root, request);
  fs.writeFileSync(path.join(root, 'src/app.mjs'), 'export const answer = 42; // fixed\n');
  assert.equal((await verify(root)).ok, false);
  assert.equal((await verify(root)).ok, true);
  await recordProof(root, 1, 'The flaky check passed on its second run.');
  assert.deepEqual(status(root).integrity.flakyChecks, ['flaky']);
  assert.deepEqual(status(root).observedFailToPass, []);
  await assert.rejects(finish(root), error => error.code === 'INTEGRITY_REVIEW_REQUIRED' && /failed and passed on this same source/.test(error.message));
  await recordReview(root, 'independent-reviewer', 'approve', 'The first failure was an unrelated environment problem.');
  assert.equal((await finish(root)).phase, 'done');
});

test('checkpoints resume task state without bypassing evidence freshness', async t => {
  const root = await fixture(t);
  await startTask(root, request);
  await checkpoint(root, 'Localized the failure; no code changed.', 'Add the boundary regression test.');
  const resumed = status(root);
  assert.equal(resumed.next.next, 'Add the boundary regression test.');
  await assert.rejects(finish(root), /Verification/);
  for (let index = 1; index < 10; index++) await checkpoint(root, `Milestone ${index}`, 'Continue.');
  await assert.rejects(checkpoint(root, 'Too many', 'Continue.'), /Checkpoint budget/);
});

test('unfinished tasks cannot be overwritten; cancelled tasks are archived', async t => {
  const root = await fixture(t);
  const first = await startTask(root, request);
  await assert.rejects(startTask(root, request), /unfinished/);
  await cancel(root, 'Split the task into a smaller independently testable change.');
  const second = await startTask(root, request);
  assert.notEqual(first.id, second.id);
  assert.ok(fs.existsSync(path.join(root, '.leanloop/history', `${first.id}.json`)));
});

test('the task lock rejects concurrent mutation and releases after an error', async t => {
  const root = await fixture(t);
  await withLock(root, async () => {
    await assert.rejects(startTask(root, request), /project lock already exists/);
  });
  await assert.rejects(withLock(root, async () => { throw new Error('deliberate test failure'); }), /deliberate/);
  assert.equal(fs.existsSync(path.join(root, '.leanloop/lock.json')), false);
});

test('configuration corruption and unknown schema fields are errors', async t => {
  const root = await fixture(t);
  fs.writeFileSync(path.join(root, 'leanloop.json'), '{"version":1,"attemptLimit":3,"checks":[],"unknown":true}');
  assert.notEqual(cli(root, ['doctor']).status, 0);
  fs.writeFileSync(path.join(root, 'leanloop.json'), '{invalid');
  assert.notEqual(cli(root, ['start', 'goal', '--accept', 'outcome']).status, 0);
});

test('Git flags hiding worktree changes fail closed', async t => {
  const root = await fixture(t);
  commit(root);
  git(root, ['update-index', '--assume-unchanged', 'src/app.mjs']);
  assert.throws(() => fingerprint(root), /assume-unchanged/);
  git(root, ['update-index', '--no-assume-unchanged', 'src/app.mjs']);
  git(root, ['update-index', '--skip-worktree', 'src/app.mjs']);
  assert.throws(() => fingerprint(root), /skip-worktree/);
});

test('root configuration changes invalidate evidence even when Git ignores configuration', async t => {
  const root = await fixture(t);
  fs.writeFileSync(path.join(root, '.git/info/exclude'), 'leanloop.json\n');
  const before = fingerprint(root);
  atomicJson(root, 'leanloop.json', { version: 1, attemptLimit: 4, checks: [] });
  assert.notEqual(fingerprint(root), before);
});

test('a successful subset cannot hide a known failing check at the same source', async t => {
  const root = await fixture(t, [
    { name: 'fails', command: [process.execPath, '-e', 'process.exit(1)'] },
    { name: 'passes', command: [process.execPath, '-e', 'process.exit(0)'] },
  ]);
  await startTask(root, request);
  assert.equal((await verify(root)).ok, false);
  const partial = await verify(root, ['passes']);
  assert.equal(partial.selectionPassed, true);
  assert.equal(partial.ok, false);
  assert.equal(partial.allChecksPassed, false);
  assert.deepEqual(partial.knownFailing, ['fails']);
  assert.equal(status(root).phase, 'blocked');
});

test('partial success explicitly reports the remaining required checks', async t => {
  const root = await fixture(t, [
    { name: 'first', command: [process.execPath, '-e', 'process.exit(0)'] },
    { name: 'second', command: [process.execPath, '-e', 'process.exit(0)'] },
  ]);
  await startTask(root, request);
  const result = await verify(root, ['first']);
  assert.equal(result.ok, true);
  assert.equal(result.allChecksPassed, false);
  assert.deepEqual(result.pendingChecks, ['second']);
});

test('status preserves the continuation point when freshness cannot be checked', async t => {
  const root = await fixture(t);
  commit(root);
  await startTask(root, request);
  await checkpoint(root, 'Investigation is localized.', 'Add a regression test.');
  git(root, ['update-index', '--assume-unchanged', 'src/app.mjs']);
  const resumed = status(root);
  assert.equal(resumed.ok, false);
  assert.equal(resumed.goal, request.goal);
  assert.equal(resumed.next.next, 'Add a regression test.');
  assert.equal(resumed.freshness.available, false);
  assert.equal(resumed.acceptance[0].fresh, null);
  assert.ok(resumed.issues.some(issue => issue.code === 'UNVERIFIABLE_INDEX'));
});

test('status also preserves task information with corrupt check configuration', async t => {
  const root = await fixture(t);
  await startTask(root, request);
  fs.writeFileSync(path.join(root, 'leanloop.json'), '{broken');
  const result = cli(root, ['status']);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.goal, request.goal);
  assert.equal(report.issues[0].component, 'configuration');
});
