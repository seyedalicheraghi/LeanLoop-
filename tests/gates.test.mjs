import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  checkpoint, escalate, finish, recordProof, recordReview, startTask, status, verify,
} from '../lib/tasks.mjs';
import { globPattern, validateConfig } from '../lib/schema.mjs';
import { atomicJson, readJson } from '../lib/io.mjs';
import { fixture, commit } from './helpers.mjs';

const request = { goal: 'Keep the answer', criteria: ['The answer is 42'] };

async function committed(t, checks) {
  const root = await fixture(t, checks);
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests/app.test.mjs'), 'assert(answer === 42);\n');
  commit(root);
  return root;
}

async function readyToFinish(root) {
  assert.equal((await verify(root)).ok, true);
  await recordProof(root, 1, 'Fixture check passed on the final source.');
}

test('editing, deleting, or committing a change to an existing test requires review before finish', async t => {
  const test = 'tests/app.test.mjs';
  for (const change of [
    root => fs.writeFileSync(path.join(root, test), 'weakened();\n'),
    root => fs.unlinkSync(path.join(root, test)),
    root => {
      fs.writeFileSync(path.join(root, test), 'weakened();\n');
      commit(root);
    },
  ]) {
    const root = await committed(t);
    await startTask(root, request);
    change(root);
    await readyToFinish(root);
    await assert.rejects(finish(root), error => error.code === 'INTEGRITY_REVIEW_REQUIRED' && error.message.includes(test));
    assert.equal(status(root).integrity.reviewRequired, true);
    await recordReview(root, 'independent-reviewer', 'approve', 'Reviewed the test change against the specification.');
    assert.equal((await finish(root)).phase, 'done');
  }
});

test('new tests and ordinary source edits finish without an integrity review', async t => {
  const root = await committed(t);
  await startTask(root, request);
  fs.writeFileSync(path.join(root, 'tests/new.test.mjs'), 'assert(true);\n');
  fs.writeFileSync(path.join(root, 'src/app.mjs'), 'export const answer = 42; // unchanged value\n');
  await readyToFinish(root);
  const done = await finish(root);
  assert.equal(done.phase, 'done');
  assert.deepEqual(done.integrity.testFiles, []);
  assert.equal(done.integrity.checkConfigChanged, false);
});

test('changing the configured checks during a task requires review', async t => {
  const root = await committed(t);
  await startTask(root, request);
  const config = readJson(root, 'leanloop.json');
  config.checks[0].command = [process.execPath, '-e', '0'];
  atomicJson(root, 'leanloop.json', config);
  await readyToFinish(root);
  await assert.rejects(finish(root), error => error.code === 'INTEGRITY_REVIEW_REQUIRED' && /check configuration/.test(error.message));
  assert.equal(status(root).integrity.checkConfigChanged, true);
});

test('testPaths decides which files count as tests', async t => {
  const root = await committed(t);
  const config = readJson(root, 'leanloop.json');
  config.testPaths = ['checks/**'];
  atomicJson(root, 'leanloop.json', config);
  commit(root);
  await startTask(root, request);
  fs.writeFileSync(path.join(root, 'tests/app.test.mjs'), 'not a configured test path\n');
  await readyToFinish(root);
  assert.equal((await finish(root)).phase, 'done');
});

test('test path globs match nested and root paths without partial-name matches', () => {
  const matches = (glob, file) => globPattern(glob).test(file);
  assert.equal(matches('**/tests/**', 'tests/a.mjs'), true);
  assert.equal(matches('**/tests/**', 'pkg/tests/deep/a.mjs'), true);
  assert.equal(matches('**/*.test.*', 'src/a.test.ts'), true);
  assert.equal(matches('**/*.test.*', 'src/attest.ts'), false);
  assert.equal(matches('**/test_*.py', 'test_api.py'), true);
  assert.equal(matches('**/tests/**', 'contests/a.mjs'), false);
  for (const bad of [['../x'], ['/abs/**'], ['a\\b'], 'tests/**']) {
    assert.throws(() => validateConfig({ version: 1, attemptLimit: 3, checks: [], testPaths: bad }), /testPaths/);
  }
});

test('escalation blocks the task with a structured record for the user', async t => {
  const root = await fixture(t);
  await startTask(root, request);
  await assert.rejects(escalate(root, 'giving-up', 'x', 'y', 'z'), /Escalation kind/);
  const result = await escalate(root, 'test-conflict', 'The test expects 41 but the specification says 42.',
    'Read the specification and the test; ran the check twice.', 'Confirm which value is correct.');
  assert.equal(result.phase, 'blocked');
  assert.equal(status(root).escalation.kind, 'test-conflict');
  assert.match(status(root).escalation.recommendation, /Confirm/);
});

test('failed checks carry an output excerpt; passing checks and checkpoints record what ran', async t => {
  const script = "const ok = require('fs').readFileSync('src/app.mjs', 'utf8').includes('42');" +
    "if (!ok) console.error('expected 42 in src/app.mjs'); process.exit(ok ? 0 : 1);";
  const root = await fixture(t, [{ name: 'unit', command: [process.execPath, '-e', script] }]);
  fs.writeFileSync(path.join(root, 'src/app.mjs'), 'export const answer = 41;\n');
  await startTask(root, request);
  const red = await verify(root);
  assert.equal(red.ok, false);
  assert.match(red.results[0].excerpt, /expected 42/);
  assert.match(red.results[0].excerptNote, /untrusted/);
  await checkpoint(root, 'Reproduced the wrong answer.', 'Restore 42.');
  assert.deepEqual(status(root).next.lastCheck, { fresh: true, passed: [], failed: ['unit'] });
  fs.writeFileSync(path.join(root, 'src/app.mjs'), 'export const answer = 42;\n');
  const green = await verify(root);
  assert.equal(green.ok, true);
  assert.equal(Object.hasOwn(green.results[0], 'excerpt'), false);
  assert.deepEqual(status(root).observedFailToPass, ['unit']);
});

test('a finished step keeps its last checkpoint in status, so a multi-step plan survives a cleared context', async t => {
  const root = await fixture(t);
  await startTask(root, { goal: 'Step 1: api', criteria: ['api check passes'], scope: ['src'] });
  assert.equal((await verify(root)).ok, true);
  await recordProof(root, 1, 'api check passed on the final source.');
  await checkpoint(root, 'api migrated to the new field.', 'Start step 2: migrate billing, then step 3: report.');
  assert.equal((await finish(root)).phase, 'done');
  const resumed = status(root);
  assert.equal(resumed.phase, 'done');
  assert.match(resumed.next.next, /step 2: migrate billing/);
  await startTask(root, { goal: 'Step 2: billing', criteria: ['billing check passes'] });
  assert.equal(status(root).next, null);
});
