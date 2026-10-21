import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import { atomicJson, readJson } from '../skills/leanloop/scripts/lib/io.mjs';
import { startTask } from '../skills/leanloop/scripts/lib/tasks.mjs';
import { fixture, cli, cliPath } from './helpers.mjs';

test('lock recovery refuses live and mismatched owners', async t => {
  const root = await fixture(t);
  atomicJson(root, '.leanloop/lock.json', { pid: process.pid });
  const live = cli(root, ['recover', '--owner-pid', String(process.pid)]);
  assert.notEqual(live.status, 0);
  assert.match(live.stderr, /still running/);
  const mismatch = cli(root, ['recover', '--owner-pid', String(process.pid + 1)]);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /does not match/);
  assert.equal(readJson(root, '.leanloop/lock.json').pid, process.pid);
});

test('recovery of a dead owner invalidates interrupted verification state', async t => {
  const root = await fixture(t);
  await startTask(root, { goal: 'Recover a task', criteria: ['Interrupted work is not passed'] });
  const task = readJson(root, '.leanloop/task.json');
  task.phase = 'checking';
  atomicJson(root, '.leanloop/task.json', task);
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(dead.status, 0);
  atomicJson(root, '.leanloop/lock.json', { pid: dead.pid });
  const result = cli(root, ['recover', '--owner-pid', String(dead.pid)]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(root, '.leanloop/task.json').phase, 'blocked');
  assert.equal(readJson(root, '.leanloop/task.json').verification, null);
  assert.equal(fs.existsSync(path.join(root, '.leanloop/lock.json')), false);
});

test('SIGTERM stops the check, records failure, and releases the lock', { timeout: 10000 }, async t => {
  const code = "require('fs').writeFileSync('.leanloop/check-started', String(process.pid)); setInterval(() => {}, 1000);";
  const root = await fixture(t, [{ name: 'long', command: [process.execPath, '-e', code], timeoutSeconds: 5 }]);
  await startTask(root, { goal: 'Interrupt a check', criteria: ['Interruption cannot be success'] });
  const child = spawn(process.execPath, [cliPath, 'check', '--project', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const marker = path.join(root, '.leanloop/check-started');
  for (let attempt = 0; attempt < 100 && !fs.existsSync(marker); attempt++) await wait(20);
  assert.equal(fs.existsSync(marker), true, stderr);
  const ownedPid = Number(fs.readFileSync(marker, 'utf8'));
  child.kill('SIGTERM');
  const result = await closed;
  assert.equal(result.code, 130, stderr || stdout);
  assert.equal(JSON.parse(stdout).results[0].interrupted, 'SIGTERM');
  assert.equal(fs.existsSync(path.join(root, '.leanloop/lock.json')), false);
  assert.equal(readJson(root, '.leanloop/task.json').phase, 'blocked');
  assert.throws(() => process.kill(ownedPid, 0), error => error.code === 'ESRCH');
});

test('a stranded checking task can be recovered after its lock was removed', async t => {
  const root = await fixture(t);
  await startTask(root, { goal: 'Resume after a crash', criteria: ['Evidence remains invalid until rerun'] });
  const task = readJson(root, '.leanloop/task.json');
  task.phase = 'checking';
  atomicJson(root, '.leanloop/task.json', task);
  const result = cli(root, ['recover', '--unlocked', '--reason', 'Verified the previous process exited.']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(root, '.leanloop/task.json').phase, 'blocked');
  assert.equal(fs.existsSync(path.join(root, '.leanloop/lock.json')), false);
});

test('invalid lock metadata is visible and can be explicitly quarantined', async t => {
  const root = await fixture(t);
  await startTask(root, { goal: 'Recover invalid metadata', criteria: ['Corruption is reported'] });
  const task = readJson(root, '.leanloop/task.json');
  task.phase = 'checking';
  atomicJson(root, '.leanloop/task.json', task);
  fs.writeFileSync(path.join(root, '.leanloop/lock.json'), '');
  const diagnostic = cli(root, ['status']);
  assert.equal(diagnostic.status, 1);
  assert.equal(JSON.parse(diagnostic.stdout).lock.invalid, true);
  assert.notEqual(cli(root, ['recover', '--broken-lock']).status, 0);
  const recovered = cli(root, ['recover', '--broken-lock', '--reason', 'Operator inspected processes and confirmed no owner.']);
  assert.equal(recovered.status, 0, recovered.stderr);
  const report = JSON.parse(recovered.stdout);
  assert.equal(fs.readFileSync(path.join(root, report.quarantine), 'utf8'), '');
  assert.equal(readJson(root, '.leanloop/task.json').phase, 'blocked');
});

test('a missing or broken lock does not allow recovery over a recorded live task owner', async t => {
  const root = await fixture(t);
  await startTask(root, { goal: 'Protect live work', criteria: ['No lock stealing'] });
  const task = readJson(root, '.leanloop/task.json');
  task.phase = 'checking';
  task.activePid = process.pid;
  atomicJson(root, '.leanloop/task.json', task);
  const result = cli(root, ['recover', '--unlocked', '--reason', 'Attempted recovery']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /still running/);
  assert.equal(readJson(root, '.leanloop/task.json').phase, 'checking');
});
