import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import { runCheck, MAX_LOG_BYTES } from '../skills/leanloop/scripts/lib/checks.mjs';
import { startTask, verify } from '../skills/leanloop/scripts/lib/tasks.mjs';
import { fixture, temporary, cli } from './helpers.mjs';

test('timeouts terminate the owned process group, including ordinary grandchildren', async t => {
  const root = await fixture(t);
  const childCode = "setTimeout(() => require('fs').writeFileSync('escaped-marker', 'unexpected'), 1700)";
  const parentCode = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio:'ignore'}); setInterval(() => {}, 1000);`;
  const result = await runCheck(root, {
    name: 'timeout', command: [process.execPath, '-e', parentCode], timeoutSeconds: 1,
  }, 'timeout-test');
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  await wait(800);
  assert.equal(fs.existsSync(path.join(root, 'escaped-marker')), false);
});

test('logs have exact byte caps and disclose truncation', async t => {
  const root = await fixture(t);
  const result = await runCheck(root, {
    name: 'noisy', command: [process.execPath, '-e', `process.stdout.write('x'.repeat(${MAX_LOG_BYTES * 3}));`],
  }, 'noisy-test');
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(fs.statSync(path.join(root, result.stdoutLog)).size, MAX_LOG_BYTES);
});

test('a missing output assertion prevents a misleading zero exit from passing', async t => {
  const root = await fixture(t);
  const result = await runCheck(root, {
    name: 'empty-suite', command: [process.execPath, '-e', 'console.log("0 tests ran")'],
    expectOutput: 'required regression test passed',
  }, 'assertion-test');
  assert.equal(result.exitCode, 0);
  assert.equal(result.expectedOutputFound, false);
  assert.equal(result.ok, false);
});

test('argument arrays do not invoke shell expansion', async t => {
  const root = await fixture(t);
  const literal = '$(touch unexpected-file); echo literal';
  const result = await runCheck(root, {
    name: 'argv', command: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', literal],
  }, 'argv-test');
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(root, result.stdoutLog), 'utf8'), literal);
  assert.equal(fs.existsSync(path.join(root, 'unexpected-file')), false);
});

test('a check cwd cannot escape through a symlink', async t => {
  const root = await fixture(t);
  const outside = temporary(t);
  fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');
  await assert.rejects(runCheck(root, {
    name: 'escape', command: [process.execPath, '-e', 'process.exit(0)'], cwd: 'linked',
  }, 'symlink-test'), /symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('check CLI reports process startup failure as nonzero, not zero tests passed', async t => {
  const root = await fixture(t, [{ name: 'missing', command: ['nonexistent-leanloop-test-command'] }]);
  await startTask(root, { goal: 'Test the runner', criteria: ['The runner must execute a command'] });
  const result = cli(root, ['check']);
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.ok(output.results[0].spawnError);
});

test('check failures stop later checks rather than spending more time', async t => {
  const root = await fixture(t, [
    { name: 'first', command: [process.execPath, '-e', 'process.exit(1)'] },
    { name: 'later', command: [process.execPath, '-e', 'throw Error("must not execute")'] },
  ]);
  await startTask(root, { goal: 'Fail early', criteria: ['Failure is reported'] });
  const result = await verify(root);
  assert.deepEqual(result.notRun, ['later']);
  assert.equal(result.results.length, 1);
});

test('large output retains its beginning and failure summary while assertions see the whole stream', async t => {
  const root = await fixture(t);
  const marker = 'a specific success marker';
  const result = await runCheck(root, {
    name: 'verbose',
    command: [process.execPath, '-e',
      `process.stdout.write('BEGIN\\n'+'x'.repeat(100000)+'${marker}'+'y'.repeat(100000)+'\\nEND');`],
    expectOutput: marker,
  }, 'verbose-test');
  assert.equal(result.ok, true);
  assert.equal(result.expectedOutputFound, true);
  assert.equal(result.truncated, true);
  const log = fs.readFileSync(path.join(root, result.stdoutLog), 'utf8');
  assert.ok(log.startsWith('BEGIN'));
  assert.ok(log.endsWith('END'));
  assert.ok(log.includes('output truncated'));
  assert.equal(Buffer.byteLength(log), MAX_LOG_BYTES);
  assert.equal(log.includes(marker), false);
});

test('output assertions match literals split across stream chunks', async t => {
  const root = await fixture(t);
  const result = await runCheck(root, {
    name: 'split', command: [process.execPath, '-e',
      "process.stdout.write('marker-'); setTimeout(() => process.stdout.write('complete'), 30);"],
    expectOutput: 'marker-complete',
  }, 'split-test');
  assert.equal(result.ok, true);
});

test('checks clear Git routing variables consistently with the fingerprint and report only their names', async t => {
  const root = await fixture(t);
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = '/an-unrelated-git-directory';
  try {
    const result = await runCheck(root, {
      name: 'git-environment', command: [process.execPath, '-e',
        'if (process.env.GIT_DIR) process.exit(9); console.log("isolated");'],
      expectOutput: 'isolated',
    }, 'environment-test');
    assert.equal(result.ok, true);
    assert.ok(result.removedEnvironment.includes('GIT_DIR'));
    assert.equal(JSON.stringify(result).includes('/an-unrelated-git-directory'), false);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});
