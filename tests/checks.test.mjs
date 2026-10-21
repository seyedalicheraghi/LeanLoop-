import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import { descendantsFromListing, runCheck, windowsCommand, MAX_LOG_BYTES } from '../lib/checks.mjs';
import { startTask, verify } from '../lib/tasks.mjs';
import { fixture, temporary, cli, link } from './helpers.mjs';

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
  link(t, outside, path.join(root, 'linked'), 'dir');
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

test('a grandchild that outlives a normally exiting check is stopped', async t => {
  const root = await fixture(t);
  const childCode = "setTimeout(() => require('fs').writeFileSync('orphan-marker', 'unexpected'), 1500)";
  const parentCode = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio:'ignore'}); setTimeout(() => process.exit(0), 300);`;
  const result = await runCheck(root, { name: 'orphan', command: [process.execPath, '-e', parentCode] }, 'orphan-test');
  assert.equal(result.ok, true, JSON.stringify(result));
  await wait(1700);
  assert.equal(fs.existsSync(path.join(root, 'orphan-marker')), false);
});

test('Windows .cmd shims run through cmd.exe with literal arguments', { skip: process.platform !== 'win32' && 'Windows only' }, async t => {
  const root = await fixture(t);
  const bin = temporary(t);
  const shim = path.join(bin, 'echoargs.cmd');
  fs.writeFileSync(shim, `@"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`);
  const result = await runCheck(root, { name: 'shim', command: [shim, 'two words', 'a&b', '(x)'] }, 'shim-test');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, result.stdoutLog), 'utf8')), ['two words', 'a&b', '(x)']);
  await assert.rejects(runCheck(root, { name: 'unsafe', command: [shim, '%PATH%'] }, 'unsafe-test'), /cannot pass/);
  const resolved = windowsCommand(['echoargs', 'x'], { Path: bin, PATHEXT: '.EXE;.CMD' });
  assert.equal(resolved.verbatim, true);
  assert.match(resolved.args.at(-1), /echoargs\.cmd" "x"/i);
  assert.deepEqual(windowsCommand(['tool.exe', 'x'], { Path: bin }), { file: 'tool.exe', args: ['x'], verbatim: false });
});

test('the Windows descendant sweep follows an edge only from a parent created no later than its child', () => {
  const started = Date.parse('2026-01-01T00:00:00.000Z');
  const at = offset => new Date(started + offset).toISOString();
  const listing = [
    `100 1 ${at(4000)}`, // the root's PID, since reused by an unrelated process
    `200 100 ${at(10)}`,
    `300 200 ${at(5)}`, // older than 200, so its parent was an earlier process that held PID 200
    `310 300 ${at(20)}`,
    `400 200 ${at(10)}`, // created in the same millisecond as its parent
    `500 400 ${at(30)}`,
    `600 100 ${at(5000)}`, // a child of the reused root PID, created after the root closed
    '',
  ].join('\r\n');
  assert.deepEqual(descendantsFromListing(listing, 100, started, started + 100).sort(), ['200', '400', '500']);
  assert.deepEqual(descendantsFromListing(listing, 100, started, null).sort(), ['200', '400', '500', '600']);
});

test('a stopped check whose descendant keeps the output pipes open returns after a bounded grace period', { timeout: 60000 }, async t => {
  const root = await fixture(t);
  // A detached grandchild whose parent exited escapes both the process-group kill and the Windows parent-chain sweep.
  const grandchild = "require('fs').writeFileSync('escaped.pid', String(process.pid)); setTimeout(() => {}, 30000);";
  const intermediate = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], ` +
    "{ stdio: 'inherit', detached: true }).unref(); setTimeout(() => process.exit(0), 300);";
  const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(intermediate)}], { stdio: 'inherit' }); ` +
    'setInterval(() => {}, 1000);';
  const marker = path.join(root, 'escaped.pid');
  try {
    const result = await runCheck(root, { name: 'held-pipes', command: [process.execPath, '-e', parent], timeoutSeconds: 2 },
      'grace-test', { closeGraceMs: 1000 });
    assert.equal(fs.existsSync(marker), true, 'the escaping grandchild must have started');
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.match(result.cleanupError, /Output pipes stayed open/);
    assert.ok(result.elapsedMs < 20000, `elapsed ${result.elapsedMs} ms`);
  } finally {
    // Stop the escaped process and wait for it, so the fixture directory it runs in can be removed.
    try {
      const pid = Number(fs.readFileSync(marker, 'utf8'));
      process.kill(pid);
      for (let attempt = 0; attempt < 100; attempt++) {
        process.kill(pid, 0);
        await wait(50);
      }
    } catch {
      // Gone; Windows releases the directory handle shortly after the process ends.
      await wait(500);
    }
  }
});

test('Windows shims resolve against the check cwd and pass trailing backslashes literally', { skip: process.platform !== 'win32' && 'Windows only' }, async t => {
  const root = await fixture(t);
  const shim = `@"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`;
  fs.mkdirSync(path.join(root, 'pkg/tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pkg/tools/echoargs.cmd'), shim);
  const resolved = windowsCommand(['tools/echoargs', 'x'], { PATHEXT: '.EXE;.CMD' }, path.join(root, 'pkg'));
  assert.equal(resolved.verbatim, true);
  assert.match(resolved.args.at(-1), /pkg\\tools\\echoargs\.cmd" "x"/i);
  // Before the fix this resolved against the LeanLoop process cwd and spawned the .cmd directly (EINVAL).
  const args = ['dir\\', 'next', 'a\\b\\\\', 'plain'];
  const result = await runCheck(root, { name: 'relative', command: ['tools/echoargs', ...args], cwd: 'pkg' }, 'relative-shim-test');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, result.stdoutLog), 'utf8')), args);
  assert.match(windowsCommand(['tools/echoargs', 'a\\'], {}, path.join(root, 'pkg')).args.at(-1), /"a\\\\""$/);
});
