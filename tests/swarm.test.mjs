import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { cliPath, git, temporary } from './helpers.mjs';
import { init } from '../lib/init.mjs';
import { atomicJson } from '../lib/io.mjs';
import { finish, recordProof, startTask, verify } from '../lib/tasks.mjs';
import {
  abandon, accept, literalPrefix, merge, ownedPathsOverlap, ownsFile, prepare, runStatus, startRun, validatePlan,
  verifyRun, workerScope,
} from '../lib/swarm.mjs';

const node = process.execPath;
const CHECK_SCRIPTS = {
  'checks/a.cjs': `const fs = require('fs');
let text = '';
try { text = fs.readFileSync('a/out.txt', 'utf8'); } catch {}
if (!text.startsWith('a ')) { console.error('a/out.txt is missing'); process.exit(1); }
console.log('a ok');
`,
  'checks/b.cjs': `const fs = require('fs');
if (!fs.existsSync('b/out.txt') || !fs.existsSync('a/out.txt')) { console.error('b needs a and b output'); process.exit(1); }
console.log('b ok');
`,
  'checks/integ.cjs': `const fs = require('fs');
for (const file of ['a/out.txt', 'b/out.txt']) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('BREAK')) { console.error('integration broke on ' + file); process.exit(1); }
}
console.log('integration ok');
`,
  'checks/sealed.cjs': `const dir = process.env.LEANLOOP_SEALED_DIR;
if (!dir) { console.error('LEANLOOP_SEALED_DIR is not set'); process.exit(3); }
require(require('path').join(dir, 'accept.cjs'));
console.log('sealed ok');
`,
};
const CONFIG = {
  version: 1, attemptLimit: 3, checks: ['a', 'b', 'integ', 'sealed'].map(name => ({ name, command: [node, `checks/${name}.cjs`] })),
};
const PLAN = {
  version: 1, spec: 'spec.md',
  packages: [
    { id: 'a', goal: 'Write a/out.txt', ownedPaths: ['a'], dependsOn: [], checks: ['a'], acceptance: ['a/out.txt starts with "a "'] },
    {
      id: 'b', goal: 'Write b/out.txt using a', ownedPaths: ['b/**'], dependsOn: ['a'], checks: ['b'],
      acceptance: ['b/out.txt exists next to a/out.txt'], contracts: ['spec.md'],
    },
  ],
  integrationChecks: ['integ'], sealedChecks: ['sealed'],
};

function write(root, files) {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
}

const plain = (root, args, options = {}) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', ...options });

async function repository(t, plan = PLAN) {
  const root = temporary(t);
  git(root, ['init', '--initial-branch=main']);
  fs.mkdirSync(path.join(root, '.git', 'no-hooks'));
  for (const [key, value] of [['user.name', 'Swarm Test'], ['user.email', 'swarm@example.invalid'],
    ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(root, '.git', 'no-hooks')], ['core.autocrlf', 'false']]) {
    git(root, ['config', key, value]);
  }
  write(root, { ...CHECK_SCRIPTS, 'spec.md': '# Spec\n\n- a and b write their outputs.\n' });
  await init(root);
  atomicJson(root, 'leanloop.json', CONFIG);
  write(root, { 'plan.json': `${JSON.stringify(plan, null, 2)}\n` });
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'bootstrap']);
  return root;
}

// A worker's LeanLoop loop in its worktree, as the subagent would run it from the brief's start command.
async function work(worktree, files, { goal, acceptance: criteria, scope }) {
  await startTask(worktree, { goal, criteria, scope });
  write(worktree, files);
  const checked = await verify(worktree);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  for (let index = 0; index < criteria.length; index += 1) await recordProof(worktree, index + 1, 'check passed');
  const done = await finish(worktree);
  assert.equal(done.phase, 'done');
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

const head = (root, ref = 'HEAD') => git(root, ['rev-parse', ref]).trim();
const branchExists = (root, branch) => plain(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).status === 0;

test('owned paths: literal prefixes, conservative overlap, and ownership matching', () => {
  assert.equal(literalPrefix('src/**/*.ts'), 'src');
  assert.equal(literalPrefix('README.md'), 'README.md');
  assert.equal(ownedPathsOverlap('src', 'src/api'), true);
  assert.equal(ownedPathsOverlap('src/**/*.ts', 'src/**/*.css'), true, 'globs sharing a directory count as overlapping');
  assert.equal(ownedPathsOverlap('src/api', 'src/apiclient'), false);
  assert.equal(ownedPathsOverlap('web/**', 'server'), false);
  // Windows and macOS file systems treat these as one directory.
  assert.equal(ownedPathsOverlap('a', 'A'), true);
  assert.equal(ownedPathsOverlap('src/api', 'src/API/**'), true);
  assert.equal(ownsFile(['src/api'], 'src/api/index.mjs'), true);
  assert.equal(ownsFile(['src/api'], 'src/apiclient/index.mjs'), false);
  assert.equal(ownsFile(['web/**/*.css'], 'web/a/b.css'), true);
  assert.equal(ownsFile(['web/**/*.css'], 'web/a/b.js'), false);
  assert.deepEqual(workerScope(['web/**/*.css', 'web/index.html', 'docs/api.md']), ['web', 'web/index.html', 'docs/api.md']);
});

test('swarm validate reports every plan error and accepts a valid plan', t => {
  const root = temporary(t);
  write(root, { 'spec.md': '# Spec\n', 'leanloop.json': JSON.stringify(CONFIG) });
  const check = plan => {
    write(root, { 'plan.json': JSON.stringify(plan) });
    return validatePlan(root, 'plan.json');
  };
  const valid = check(PLAN);
  assert.equal(valid.ok, true, JSON.stringify(valid.errors));
  assert.deepEqual(valid.waves, [['a'], ['b']]);
  assert.equal(valid.maxConcurrentWorkers, 1);

  const pkg = (id, extra = {}) => ({ id, goal: `Goal ${id}`, ownedPaths: [id], dependsOn: [], checks: ['a'], acceptance: ['works'], ...extra });
  const expectError = (plan, pattern) => {
    const result = check(plan);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => pattern.test(error)), `${pattern} not in ${JSON.stringify(result.errors)}`);
  };
  const base = { version: 1, spec: 'spec.md' };
  expectError({ ...base, packages: [pkg('x', { dependsOn: ['y'] }), pkg('y', { dependsOn: ['x'] })] }, /cycle among packages: x, y/);
  expectError({ ...base, packages: [pkg('x', { dependsOn: ['ghost'] })] }, /unknown package "ghost"/);
  expectError({ ...base, packages: [pkg('x'), pkg('x', { ownedPaths: ['other'] })] }, /Duplicate package id: x/);
  expectError({ ...base, packages: [pkg('x', { ownedPaths: ['src'] }), pkg('y', { ownedPaths: ['src/api'] })] }, /overlap: "src" \(x\) and "src\/api" \(y\)/);
  expectError({ ...base, packages: [pkg('x', { ownedPaths: ['web/**/*.js'] }), pkg('y', { ownedPaths: ['web/**/*.css'] })] }, /overlap/);
  expectError({ ...base, packages: [pkg('x', { checks: [] })] }, /checks must be a nonempty array/);
  expectError({ ...base, packages: [pkg('x', { checks: undefined })] }, /checks must be a nonempty array/);
  expectError({ ...base, packages: [pkg('x', { checks: ['missing'] })] }, /"missing" is not a check/);
  expectError({ ...base, packages: [pkg('x', { acceptance: [] })] }, /1-10 acceptance criteria/);
  expectError({ ...base, packages: [pkg('x', { acceptance: Array.from({ length: 11 }, (_, i) => `c${i}`) })] }, /1-10 acceptance criteria/);
  expectError({ ...base, packages: Array.from({ length: 21 }, (_, i) => pkg(`p${i}`)) }, /at most 20 packages/);
  expectError({ ...base, packages: [pkg('Bad_Id')] }, /lowercase identifier/);
  expectError({ ...base, packages: [pkg('integration')] }, /lowercase identifier/);
  expectError({ ...base, packages: [pkg('x', { ownedPaths: [] })] }, /ownedPaths must be a nonempty array/);
  expectError({ ...base, packages: [pkg('x', { ownedPaths: ['../outside'] })] }, /must not contain/);
  expectError({ ...base, packages: [pkg('x', { ownedPaths: ['**/*.js'] })] }, /literal directory or file/);
  expectError({ ...base, packages: [pkg('x', { ownedPaths: ['.leanloop/sealed'] })] }, /LeanLoop or Git state/);
  expectError({ ...base, packages: [pkg('x', { ownedPaths: ['leanloop.json'] })] }, /LeanLoop or Git state/);
  expectError({ ...base, packages: [pkg('x', { dependsOn: ['x'] })] }, /depends on itself/);
  expectError({ ...base, packages: [pkg('x', { checks: ['sealed'] })], sealedChecks: ['sealed'] }, /sealed check "sealed" cannot be a package check/);
  expectError({ ...base, spec: 'missing.md', packages: [pkg('x')] }, /Spec file not found/);
  expectError({ ...base, version: 2, packages: [pkg('x')] }, /version must be 1/);
  expectError({ ...base, packages: [pkg('x', { extra: true })] }, /unknown fields extra/);
  expectError({ ...base, packages: [pkg('x')], integrationChecks: ['nope'] }, /integrationChecks: "nope"/);

  // Owned paths that differ only in letter case name one directory on Windows and macOS.
  expectError({ ...base, packages: [pkg('x', { ownedPaths: ['a'] }), pkg('y', { ownedPaths: ['A'] })] }, /overlap: "a" \(x\) and "A" \(y\)/);
  expectError({ ...base, packages: [pkg('x', { ownedPaths: ['src/api'] }), pkg('y', { ownedPaths: ['src/API'] })] }, /overlap/);
  expectError({ ...base, packages: [pkg('x', { ownedPaths: ['.LeanLoop/sealed'] })] }, /LeanLoop or Git state/);
  expectError({ ...base, packages: [pkg('x', { ownedPaths: ['LeanLoop.json'] })] }, /LeanLoop or Git state/);

  // A package cannot own what an integration, sealed, or other package's check runs.
  expectError({ ...base, packages: [pkg('x', { ownedPaths: ['x', 'checks/integ.cjs'] })], integrationChecks: ['integ'] },
    /"x" owned path "checks\/integ.cjs" covers checks\/integ.cjs, which defines check "integ"/);
  expectError({ ...base, packages: [pkg('x', { ownedPaths: ['checks'] })], sealedChecks: ['sealed'] }, /covers checks\/sealed.cjs/);
  expectError({ ...base, packages: [pkg('x', { checks: ['a'] }), pkg('y', { checks: ['b'], ownedPaths: ['checks/A.cjs'] })] },
    /"y" owned path "checks\/A.cjs" covers checks\/a.cjs, which defines check "a"/);
  expectError({ ...base, packages: [pkg('x', { checks: ['a'] }), pkg('y', { checks: ['a'], ownedPaths: ['checks/a.cjs'] })] },
    /"y" owned path "checks\/a.cjs" .*check "a"/);
  const own = check({ ...base, packages: [pkg('x', { checks: ['a'], ownedPaths: ['x', 'checks/a.cjs'] })], integrationChecks: ['integ'] });
  assert.equal(own.ok, true, `a package may own its own check runner: ${JSON.stringify(own.errors)}`);
  write(root, { 'leanloop.json': JSON.stringify({
    ...CONFIG, checks: [...CONFIG.checks, { name: 'web', command: ['npm', 'test'], cwd: 'web' }, { name: 'jest', command: ['npx', 'jest'] }],
  }) });
  expectError({ ...base, packages: [pkg('x', { ownedPaths: ['web/**'] })], integrationChecks: ['web'] }, /covers web\/package.json/);
  expectError({ ...base, packages: [pkg('x', { ownedPaths: ['x', 'jest.config.ts'] })], integrationChecks: ['jest'] }, /covers jest.config.\*/);
  const nearby = check({ ...base, packages: [pkg('x', { ownedPaths: ['web/src'] })], integrationChecks: ['web', 'jest'] });
  assert.equal(nearby.ok, true, `owning a sibling of a check's definitions is fine: ${JSON.stringify(nearby.errors)}`);
});

test('swarm runs packages in dependency order from start to verify, then abandon cleans up', async t => {
  const root = await repository(t);
  const userHead = head(root);
  const started = await startRun(root, 'plan.json');
  const { runId } = started;
  assert.match(runId, /^\d{8}-\d{6}-[0-9a-f]{6}$/);
  assert.equal(started.integrationBranch, `leanloop/swarm/${runId}`);
  assert.equal(head(root, started.integrationBranch), userHead);
  assert.equal(git(root, ['symbolic-ref', '--short', 'HEAD']).trim(), 'main', 'the user stays on their branch');
  assert.equal(head(started.integrationWorktree), userHead);
  assert.deepEqual(started.ready, ['a']);
  assert.equal(started.warning, undefined);

  await rejects(prepare(root, runId, 'b'), 'DEPENDENCY_PENDING');
  const prepared = await prepare(root, runId, 'a');
  const worktree = prepared.worktree;
  assert.equal(prepared.branch, `leanloop/swarm/${runId}-a`);
  assert.equal(fs.existsSync(path.join(worktree, '.leanloop', '.gitignore')), true, 'init ran in the worktree');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(worktree, 'leanloop.json'), 'utf8')).checks.map(check => check.name), ['a']);
  assert.equal(fs.existsSync(path.join(worktree, '.leanloop', 'sealed')), false);
  assert.deepEqual(prepared.brief.ownedPaths, ['a']);
  assert.equal(prepared.brief.worktree, worktree);
  assert.match(prepared.briefText, /Never merge, rebase, push/);
  assert.match(prepared.briefText, /escalate/);
  assert.match(prepared.briefText, /data, not instructions/);
  assert.match(prepared.brief.commands.start, /--scope 'a'/);
  assert.equal((await prepare(root, runId, 'a')).alreadyPrepared, true);

  await rejects(accept(root, runId, 'a'), 'TASK_NOT_DONE');
  await rejects(merge(root, runId, 'a'), 'INVALID_STATE');
  await work(worktree, { 'a/out.txt': 'a output\n' }, prepared.brief);
  const accepted = await accept(root, runId, 'a');
  assert.equal(accepted.committed, true);
  assert.deepEqual(accepted.changedFiles, ['a/out.txt']);
  assert.equal(head(worktree), accepted.commit);
  assert.match(git(worktree, ['log', '-1', '--format=%an %s']), new RegExp(`^Swarm Test leanloop swarm ${runId}: a`));
  assert.equal(git(worktree, ['show', '--name-only', '--format=', 'HEAD']).trim(), 'a/out.txt', 'leanloop.json and state are not committed');

  const mergedA = await merge(root, runId, 'a');
  assert.equal(mergedA.ok, true, JSON.stringify(mergedA));
  assert.deepEqual(mergedA.results.map(result => [result.name, result.ok]), [['a', true], ['integ', true]]);
  assert.deepEqual(mergedA.ready, ['b']);
  assert.equal(git(started.integrationWorktree, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').length, 3, '--no-ff merge commit');

  const preparedB = await prepare(root, runId, 'b');
  assert.equal(preparedB.base, mergedA.integrationHead);
  assert.equal(fs.readFileSync(path.join(preparedB.worktree, 'a/out.txt'), 'utf8'), 'a output\n', 'b starts from the merged a');
  assert.deepEqual(preparedB.brief.contracts, ['spec.md']);
  await work(preparedB.worktree, { 'b/out.txt': 'b output\n' }, preparedB.brief);
  await accept(root, runId, 'b');
  const mergedB = await merge(root, runId, 'b');
  assert.equal(mergedB.ok, true, JSON.stringify(mergedB));
  assert.match(mergedB.next, /swarm verify/);

  await rejects(verifyRun(root, runId), 'NOT_FOUND');
  write(root, { '.leanloop/sealed/accept.cjs': 'throw new Error("sealed acceptance failed");\n' });
  const red = await verifyRun(root, runId);
  assert.equal(red.ok, false);
  assert.equal(red.results[0].exitCode, 1, 'the sealed directory was reachable through LEANLOOP_SEALED_DIR');
  write(root, { '.leanloop/sealed/accept.cjs': `const fs = require('fs');
if (fs.readFileSync('a/out.txt', 'utf8') !== 'a output\\n' || !fs.existsSync('b/out.txt')) process.exit(4);
` });
  const green = await verifyRun(root, runId);
  assert.equal(green.ok, true, JSON.stringify(green));
  assert.equal(green.integrationHead, mergedB.integrationHead);
  assert.equal(process.env.LEANLOOP_SEALED_DIR, undefined, 'the sealed directory is not leaked to later commands');

  const shown = runStatus(root, runId);
  assert.deepEqual(shown.packages.map(item => [item.id, item.state]), [['a', 'merged'], ['b', 'merged']]);
  assert.equal(shown.verification.ok, true);
  assert.equal(shown.verification.fresh, true);
  assert.deepEqual(runStatus(root).runs.map(run => [run.runId, run.phase]), [[runId, 'active']]);

  await rejects(abandon(root, runId, ' '), 'INVALID_INPUT');
  assert.equal(runStatus(root, runId).phase, 'active', 'no reason, no cleanup');
  const abandoned = await abandon(root, runId, 'Test run finished');
  assert.equal(abandoned.ok, true, JSON.stringify(abandoned));
  assert.equal(abandoned.branchTips[started.integrationBranch], mergedB.integrationHead);
  for (const location of [started.integrationWorktree, worktree, preparedB.worktree]) assert.equal(fs.existsSync(location), false, location);
  assert.equal(fs.existsSync(path.join(root, '.leanloop', 'worktrees', runId)), false);
  for (const branch of [started.integrationBranch, prepared.branch, preparedB.branch]) assert.equal(branchExists(root, branch), false, branch);
  assert.equal(git(root, ['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
  assert.equal(head(root), userHead, 'the user branch is untouched');
  assert.equal(git(root, ['symbolic-ref', '--short', 'HEAD']).trim(), 'main');
  const after = runStatus(root, runId);
  assert.equal(after.phase, 'abandoned');
  assert.equal(after.abandonment.reason, 'Test run finished');
  await rejects(prepare(root, runId, 'a'), 'RUN_NOT_ACTIVE');
});

test('swarm accept refuses unfinished tasks, stale evidence, and changes outside owned paths', async t => {
  const root = await repository(t);
  const { runId } = await startRun(root, 'plan.json');
  const { worktree, branch, brief } = await prepare(root, runId, 'a');
  await rejects(accept(root, runId, 'a'), 'TASK_NOT_DONE');

  await startTask(worktree, { goal: brief.goal, criteria: brief.acceptance, scope: brief.scope });
  write(worktree, { 'a/out.txt': 'a output\n' });
  await assert.rejects(accept(root, runId, 'a'), error => error.code === 'TASK_NOT_DONE' && /active, not done/.test(error.message));
  assert.equal((await verify(worktree)).ok, true);
  await recordProof(worktree, 1, 'check passed');
  await finish(worktree);

  // A commit after finish makes the recorded evidence stale.
  write(worktree, { 'stray.txt': 'outside the package\n' });
  git(worktree, ['add', 'stray.txt']);
  git(worktree, ['commit', '-q', '-m', 'worker commit outside owned paths']);
  await assert.rejects(accept(root, runId, 'a'), error => error.code === 'TASK_NOT_DONE' && /stale/.test(error.message));

  const config = JSON.parse(fs.readFileSync(path.join(worktree, 'leanloop.json'), 'utf8'));
  write(worktree, { 'leanloop.json': JSON.stringify({ ...config, attemptLimit: 5 }), 'notes/x.txt': 'uncommitted and unowned\n' });
  await work(worktree, {}, brief);
  const tip = head(worktree);
  await assert.rejects(accept(root, runId, 'a'), error => {
    assert.equal(error.code, 'OUT_OF_SCOPE');
    for (const file of ['stray.txt', 'notes/x.txt', 'leanloop.json (check configuration)']) assert.ok(error.message.includes(file), error.message);
    assert.ok(!error.message.includes('a/out.txt'), 'owned files are not reported');
    return true;
  });
  assert.equal(head(worktree), tip, 'a refused accept commits nothing');
  assert.equal(head(root, branch), tip);
  assert.equal(runStatus(root, runId).packages[0].state, 'prepared');
  await abandon(root, runId, 'cleanup');
});

test('swarm merge aborts a conflict, marks rework, and refuses a refresh that would conflict', async t => {
  const root = await repository(t);
  const { runId, integrationWorktree } = await startRun(root, 'plan.json');
  const { worktree, brief } = await prepare(root, runId, 'a');
  // The integration branch changes an owned file behind the package's back.
  write(integrationWorktree, { 'a/out.txt': 'a lead version\n' });
  git(integrationWorktree, ['add', 'a/out.txt']);
  git(integrationWorktree, ['commit', '-q', '-m', 'lead edit']);
  const before = head(integrationWorktree);
  await work(worktree, { 'a/out.txt': 'a worker version\n' }, brief);
  await accept(root, runId, 'a');
  const conflicted = await merge(root, runId, 'a');
  assert.equal(conflicted.ok, false);
  assert.equal(conflicted.conflict, true);
  assert.deepEqual(conflicted.files, ['a/out.txt']);
  assert.equal(head(integrationWorktree), before);
  assert.notEqual(plain(integrationWorktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status, 0, 'the merge was aborted');
  assert.deepEqual(git(integrationWorktree, ['status', '--porcelain']).trim(), '');
  const shown = runStatus(root, runId).packages.find(item => item.id === 'a');
  assert.equal(shown.state, 'rework');
  assert.equal(shown.rework.kind, 'conflict');

  // Another call holding the run lock blocks state changes.
  const lock = path.join(root, '.leanloop', 'swarm', runId, 'lock.json');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  await assert.rejects(prepare(root, runId, 'a'), error => error.code === 'LOCKED' && /still running/.test(error.message));
  fs.unlinkSync(lock);

  const refreshed = await prepare(root, runId, 'a');
  assert.equal(refreshed.ok, false);
  assert.equal(refreshed.code, 'REFRESH_CONFLICT');
  assert.deepEqual(refreshed.conflicts, ['a/out.txt']);
  assert.notEqual(plain(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status, 0, 'the refresh merge was aborted');
  await abandon(root, runId, 'cleanup');
});

test('swarm merge rolls back the integration branch when checks fail, and rework can then merge', async t => {
  const root = await repository(t);
  const { runId, integrationWorktree } = await startRun(root, 'plan.json');
  const { worktree, brief } = await prepare(root, runId, 'a');
  const before = head(integrationWorktree);
  await work(worktree, { 'a/out.txt': 'a BREAK\n' }, brief);
  await accept(root, runId, 'a');
  const failed = await merge(root, runId, 'a');
  assert.equal(failed.ok, false);
  assert.equal(failed.rolledBack, true);
  assert.deepEqual(failed.results.map(result => [result.name, result.ok]), [['a', true], ['integ', false]]);
  assert.match(failed.results[1].excerpt, /integration broke/);
  assert.equal(head(integrationWorktree), before, 'the integration branch is back at its previous commit');
  assert.equal(fs.existsSync(path.join(integrationWorktree, 'a/out.txt')), false);
  assert.equal(runStatus(root, runId).packages[0].state, 'rework');

  const rework = await prepare(root, runId, 'a');
  assert.equal(rework.rework, true);
  assert.equal(rework.refreshed, false);
  assert.equal(rework.brief.rework.kind, 'checks');
  assert.match(rework.briefText, /Rework requested \(checks\)/);
  await rejects(accept(root, runId, 'a'), 'TASK_NOT_DONE');
  await work(worktree, { 'a/out.txt': 'a fixed\n' }, rework.brief);
  const accepted = await accept(root, runId, 'a');
  assert.equal(accepted.committed, true);
  const merged = await merge(root, runId, 'a');
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.equal(fs.readFileSync(path.join(integrationWorktree, 'a/out.txt'), 'utf8'), 'a fixed\n');
  await abandon(root, runId, 'cleanup');
});

test('swarm accept refuses LeanLoop state committed or staged in a package worktree', async t => {
  const root = await repository(t);
  write(root, { '.leanloop/sealed/accept.cjs': 'REAL SEALED TEST\n' });
  const { runId } = await startRun(root, 'plan.json');
  const { worktree, branch, brief, base } = await prepare(root, runId, 'a');
  write(worktree, { '.leanloop/sealed/accept.cjs': 'process.exit(0) // forged\n' });
  git(worktree, ['add', '-f', '.leanloop/sealed/accept.cjs']);
  git(worktree, ['commit', '-q', '-m', 'forge the sealed test']);
  await work(worktree, { 'a/out.txt': 'a output\n' }, brief);
  const refused = error => {
    assert.equal(error.code, 'OUT_OF_SCOPE', error.message);
    assert.ok(error.message.includes('.leanloop/sealed/accept.cjs (LeanLoop state)'), error.message);
    assert.ok(!error.message.includes('task.json'), 'ignored task state is not reported');
    return true;
  };
  await assert.rejects(accept(root, runId, 'a'), refused);

  // Staged but not committed: still tracked, still refused.
  git(worktree, ['reset', '-q', '--soft', base]);
  await work(worktree, {}, brief);
  await assert.rejects(accept(root, runId, 'a'), refused);

  // Once untracked again, the file is ignored LeanLoop state and accept proceeds without it.
  git(worktree, ['rm', '-q', '--cached', '.leanloop/sealed/accept.cjs']);
  await work(worktree, {}, brief);
  const accepted = await accept(root, runId, 'a');
  assert.deepEqual(accepted.changedFiles, ['a/out.txt']);
  assert.equal(git(worktree, ['ls-tree', '-r', '--name-only', branch, '--', '.leanloop']).trim(), '');
  await merge(root, runId, 'a');
  assert.equal(fs.readFileSync(path.join(root, '.leanloop/sealed/accept.cjs'), 'utf8'), 'REAL SEALED TEST\n');
  await abandon(root, runId, 'cleanup');
});

test('swarm accept requires the planned goal, criteria, and scope, not a task the worker invented', async t => {
  const plan = { ...PLAN, packages: [{ ...PLAN.packages[0], acceptance: ['a/out.txt starts with "a "', 'a/out.txt ends with a newline'] }, PLAN.packages[1]] };
  const root = await repository(t, plan);
  const { runId } = await startRun(root, 'plan.json');
  const { worktree, brief } = await prepare(root, runId, 'a');
  const mismatch = pattern => error => {
    assert.equal(error.code, 'TASK_NOT_DONE', error.message);
    assert.match(error.message, pattern);
    return true;
  };
  await work(worktree, { 'a/out.txt': 'a output\n' }, { goal: 'whatever', acceptance: ['trivially true'], scope: brief.scope });
  await assert.rejects(accept(root, runId, 'a'), mismatch(/task's goal, acceptance criteria \(the plan has 2\) differ/));
  await work(worktree, {}, { ...brief, acceptance: brief.acceptance.slice(0, 1) });
  await assert.rejects(accept(root, runId, 'a'), mismatch(/task's acceptance criteria \(the plan has 2\) differ/));
  await work(worktree, {}, { ...brief, acceptance: [...brief.acceptance].reverse() });
  await assert.rejects(accept(root, runId, 'a'), mismatch(/acceptance criteria/));
  await work(worktree, {}, { ...brief, scope: [] });
  await assert.rejects(accept(root, runId, 'a'), mismatch(/task's scope differ/));
  await work(worktree, {}, brief);
  assert.equal((await accept(root, runId, 'a')).ok, true);
  await abandon(root, runId, 'cleanup');
});

test('swarm merge refuses a package already merged outside the helper and resumes an interrupted merge', async t => {
  const root = await repository(t);
  const { runId, integrationWorktree } = await startRun(root, 'plan.json');
  const { worktree, branch, brief } = await prepare(root, runId, 'a');
  await work(worktree, { 'a/out.txt': 'a BREAK\n' }, brief);
  const { commit } = await accept(root, runId, 'a');
  const before = head(integrationWorktree);

  // A merge the helper did not start: refused, and nothing is reset.
  git(integrationWorktree, ['merge', '--no-ff', '--no-edit', branch]);
  const manual = head(integrationWorktree);
  await rejects(merge(root, runId, 'a'), 'INVALID_STATE');
  assert.equal(head(integrationWorktree), manual);
  assert.equal(runStatus(root, runId).packages[0].state, 'accepted');

  // An interrupted helper call: the tip before the merge was recorded, then git merge ran, then the call died.
  git(integrationWorktree, ['reset', '-q', '--hard', before]);
  const stateFile = path.join(root, '.leanloop', 'swarm', runId, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.packages.a.mergeFrom = before;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  git(integrationWorktree, ['merge', '--no-ff', '--no-edit', branch]);
  assert.equal(git(integrationWorktree, ['rev-parse', 'HEAD^2']).trim(), commit);
  const resumed = await merge(root, runId, 'a');
  assert.equal(resumed.ok, false);
  assert.equal(resumed.rolledBack, true);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.integrationHead, before);
  assert.equal(head(integrationWorktree), before, 'rolled back to the commit before the interrupted merge');
  assert.equal(fs.existsSync(path.join(integrationWorktree, 'a/out.txt')), false);
  assert.equal(runStatus(root, runId).packages[0].state, 'rework');
  await abandon(root, runId, 'cleanup');
});

test('swarm abandon keeps worktrees holding uncommitted work and removes them once clean', async t => {
  const root = await repository(t);
  const { runId, integrationWorktree, integrationBranch } = await startRun(root, 'plan.json');
  const { worktree, branch } = await prepare(root, runId, 'a');
  write(worktree, { 'a/out.txt': 'unfinished worker output\n' });
  write(integrationWorktree, { 'notes.txt': 'lead notes\n' });
  const first = await abandon(root, runId, 'pause');
  assert.equal(first.ok, false);
  assert.deepEqual(first.keptWorktrees.map(item => [item.path, item.branch]).sort(),
    [[integrationWorktree, integrationBranch], [worktree, branch]].sort());
  assert.match(first.keptWorktrees.find(item => item.branch === branch).reason, /uncommitted changes: a\/out.txt/);
  assert.match(first.next, /swarm abandon/);
  assert.equal(fs.readFileSync(path.join(worktree, 'a/out.txt'), 'utf8'), 'unfinished worker output\n');
  assert.equal(fs.readFileSync(path.join(integrationWorktree, 'notes.txt'), 'utf8'), 'lead notes\n');
  assert.equal(branchExists(root, branch), true);
  assert.equal(branchExists(root, integrationBranch), true);
  assert.equal(runStatus(root, runId).phase, 'abandoned');

  // Commit the worker's output on its branch and drop the notes; a second abandon then cleans up.
  git(worktree, ['add', 'a/out.txt']);
  git(worktree, ['commit', '-q', '-m', 'keep the worker output']);
  const saved = head(worktree);
  fs.unlinkSync(path.join(integrationWorktree, 'notes.txt'));
  const second = await abandon(root, runId, 'pause, work committed');
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(second.keptWorktrees, []);
  assert.equal(second.branchTips[branch], saved, 'the committed work is recorded');
  for (const location of [worktree, integrationWorktree]) assert.equal(fs.existsSync(location), false, location);
  assert.equal(branchExists(root, branch), false);
  assert.equal(git(root, ['cat-file', '-t', saved]).trim(), 'commit');
  assert.equal(runStatus(root, runId).abandonment.previousPhase, 'active');
});

test('swarm prepare removes the new branch when the checkout fails, and leaves other worktrees registered', async t => {
  const root = await repository(t);
  // A user worktree on a drive that is not mounted right now: its directory is missing.
  const away = path.join(temporary(t), 'away');
  git(root, ['worktree', 'add', '-q', '-b', 'user-side', away]);
  fs.rmSync(away, { recursive: true, force: true });
  const registered = () => git(root, ['worktree', 'list', '--porcelain']).split('\n')
    .filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
  const userEntries = registered().length;

  const { runId } = await startRun(root, 'plan.json');
  // A required smudge filter that fails makes the checkout fail after Git created the branch.
  fs.writeFileSync(path.join(root, '.git', 'info', 'attributes'), 'spec.md filter=broken\n');
  git(root, ['config', 'filter.broken.smudge', 'false']);
  git(root, ['config', 'filter.broken.required', 'true']);
  await rejects(prepare(root, runId, 'a'), 'GIT_FAILED');
  assert.equal(branchExists(root, `leanloop/swarm/${runId}-a`), false, 'the half-created branch is gone');
  assert.equal(fs.existsSync(path.join(root, '.leanloop', 'worktrees', runId, 'a')), false);
  assert.equal(registered().length, userEntries + 1, 'only the integration worktree was added; the user entry stays');
  assert.equal(runStatus(root, runId).packages[0].state, 'planned');

  fs.unlinkSync(path.join(root, '.git', 'info', 'attributes'));
  const prepared = await prepare(root, runId, 'a');
  assert.equal(prepared.ok, true);
  const abandoned = await abandon(root, runId, 'cleanup');
  assert.equal(abandoned.ok, true, JSON.stringify(abandoned));
  assert.equal(registered().length, userEntries, 'abandon removed only the run\'s worktrees');
  assert.ok(registered().some(location => path.basename(location) === 'away'), 'the missing user worktree is still registered');
  assert.equal(branchExists(root, 'user-side'), true);
});

test('swarm calls with an unknown run id leave no run directory behind', async t => {
  const root = await repository(t);
  const ghost = '20991231-000000-abcdef';
  for (const call of [() => prepare(root, ghost, 'a'), () => accept(root, ghost, 'a'), () => merge(root, ghost, 'a'),
    () => verifyRun(root, ghost), () => abandon(root, ghost, 'typo')]) {
    await rejects(call(), 'NOT_FOUND');
  }
  assert.equal(fs.existsSync(path.join(root, '.leanloop', 'swarm', ghost)), false);
  assert.deepEqual(runStatus(root).runs, []);
  await rejects(prepare(root, 'not-a-run', 'a'), 'INVALID_INPUT');
});

test('leanloop.mjs routes swarm commands and keeps the other commands working', async t => {
  const root = await repository(t);
  const run = args => spawnSync(node, [cliPath, ...args], { encoding: 'utf8', timeout: 60000 });
  const valid = run(['swarm', 'validate', 'plan.json', '--project', root]);
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout).order, ['a', 'b']);
  write(root, { 'bad.json': JSON.stringify({ ...PLAN, packages: [] }) });
  const invalid = run(['swarm', 'validate', 'bad.json', '--project', root]);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).ok, false);
  assert.equal(run(['swarm', 'bogus', '--project', root]).status, 2);
  const missingReason = run(['swarm', 'abandon', '20261021-120000-abcdef', '--project', root]);
  assert.equal(missingReason.status, 2);
  assert.match(missingReason.stderr, /--reason/);
  assert.match(run(['swarm', '--help']).stdout, /swarm prepare RUN PACKAGE/);
  const listed = run(['swarm', 'status', '--project', root]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).runs, []);
  const guided = run(['status', '--project', root]);
  assert.equal(guided.status, 0, guided.stderr);
  assert.equal(JSON.parse(guided.stdout).task, null);
});
