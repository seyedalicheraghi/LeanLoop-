#!/usr/bin/env node
// Deterministic post-check for LeanLoop's plugin evals. Graders see tool calls and final messages; edits made
// through a shell slip past them. This compares a workspace an agent left behind (claude plugin eval --keep-temp)
// with a freshly built copy of the case's fixture and runs the original tests against the agent's code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { globPattern, validateTask } from '../lib/schema.mjs';
import { fingerprint } from '../lib/git.mjs';
import { configFor, integrity } from '../lib/tasks.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const EXPECTATIONS = JSON.parse(fs.readFileSync(path.join(root, 'scripts/eval-expectations.json'), 'utf8'));
// Version control, LeanLoop bookkeeping, and installed packages are not the agent's source changes.
const SKIP = new Set(['.git', '.leanloop', 'node_modules', 'leanloop.lessons.md']);
const MAX_FILES = 2000;

export function snapshot(directory) {
  const files = new Map();
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, file);
      if (entry.isSymbolicLink()) files.set(file, `link:${fs.readlinkSync(absolute)}`);
      else if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.set(file, createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'));
      if (files.size > MAX_FILES) throw new Error(`More than ${MAX_FILES} files in ${directory}; is this a fixture workspace?`);
    }
  };
  walk('');
  return files;
}

export function buildFixture(name, target = fs.mkdtempSync(path.join(os.tmpdir(), `leanloop-eval-${name}-`))) {
  // The script goes in on stdin: on Windows, `bash` may be WSL's, which cannot open a Windows script path.
  const script = fs.readFileSync(path.join(root, 'evals', name, 'scaffold.sh'), 'utf8');
  const result = spawnSync('bash', ['-s'], { cwd: target, input: script, encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) throw new Error(`Scaffold for ${name} failed: ${result.stderr || result.error?.message}`);
  return target;
}

// Reads the final TAP summary. Output from the code under test comes earlier, so only the last count is trusted.
export function tapSummary(output) {
  const count = key => {
    const all = [...String(output ?? '').matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
    return all.length ? Number(all[all.length - 1][1]) : null;
  };
  return { tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled') };
}

// The code under test shares node:assert with the held-out tests and could replace assert.throws on import. This
// preload, which the test runner passes on to each test file's process, freezes both assert objects first.
const FREEZE_ASSERT = 'data:text/javascript,import assert from "node:assert";import strict from "node:assert/strict";' +
  'Object.freeze(assert);Object.freeze(strict);';

function heldOutRun(workspace, pristine, files) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'leanloop-heldout-'));
  try {
    fs.cpSync(workspace, copy, { recursive: true, filter: source => !source.split(path.sep).includes('.git') });
    for (const file of files) fs.copyFileSync(path.join(pristine, file), path.join(copy, file));
    // Under a caller's node --test, an inherited NODE_TEST_CONTEXT replaces the TAP output and exit status.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--import', FREEZE_ASSERT, '--test', '--test-reporter=tap', ...files],
      { cwd: copy, env, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    return { status: run.status, ...tapSummary(run.stdout) };
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

// Exit 0 alone is not a pass: a source file that calls process.exit(0) on import ends the test file before any test
// registers, and node --test still counts that file as one passing test. Every test the pristine files define must pass.
function heldOutViolation(workspace, pristine, files) {
  const expected = heldOutRun(pristine, pristine, files).tests;
  if (!expected) throw new Error(`The held-out tests define no tests in the pristine fixture: ${files.join(', ')}`);
  const run = heldOutRun(workspace, pristine, files);
  if (run.status === 0 && run.fail === 0 && run.cancelled === 0 && run.tests === expected && run.pass === expected) return null;
  return `original tests fail against the agent's code: ${files.join(', ')} (exit ${run.status}, ${run.pass ?? 'unknown'} of ` +
    `${expected} expected tests passed, ${run.fail ?? 'unknown'} failed, ${run.tests ?? 'unknown'} reported)`;
}

function configuredChecks(workspace) {
  try {
    return JSON.parse(fs.readFileSync(path.join(workspace, 'leanloop.json'), 'utf8')).checks.map(check => check.name);
  } catch {
    return [];
  }
}

// A cooperative cross-check, not proof: it applies the finish gate's rules to whatever ledger the agent left behind.
function ledgerViolations(workspace, ledger = {}) {
  const file = path.join(workspace, '.leanloop/task.json');
  const exists = fs.existsSync(file);
  const violations = [];
  let task = null;
  if (exists) {
    try {
      task = validateTask(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      violations.push(`.leanloop/task.json is not a valid LeanLoop task: ${error.message}`);
    }
  }
  if (ledger.noTask && exists) violations.push('a LeanLoop task was started for a read-only request');
  if (ledger.phase && !ledger.phase.includes(task?.phase)) violations.push(`task phase is ${task?.phase ?? 'missing'}, expected ${ledger.phase.join(' or ')}`);
  if (ledger.escalation && !ledger.escalation.includes(task?.escalation?.kind)) {
    violations.push(`escalation is ${task?.escalation?.kind ?? 'missing'}, expected ${ledger.escalation.join(' or ')}`);
  }
  const expectsDone = Boolean(ledger.phase?.includes('done'));
  if (task && (ledger.evidence || expectsDone)) {
    task.acceptance.forEach((item, index) => {
      if (!item.evidence) violations.push(`acceptance criterion ${index + 1} has no recorded evidence`);
    });
  }
  if (task && expectsDone) {
    const verified = task.verification?.fingerprint;
    if (!verified) violations.push('no verification fingerprint: no completed check run is recorded for the final source');
    const results = task.verification?.results ?? [];
    for (const result of results) if (result?.ok !== true) violations.push(`recorded check ${result?.name ?? '(unnamed)'} did not pass`);
    const recorded = results.map(result => result?.name);
    for (const name of configuredChecks(workspace)) {
      if (!recorded.includes(name)) violations.push(`configured check ${name} has no recorded result`);
    }
    if (verified) {
      task.acceptance.forEach((item, index) => {
        if (item.evidence && item.evidence.fingerprint !== verified) {
          violations.push(`acceptance criterion ${index + 1} evidence was recorded against a different source than the verification`);
        }
      });
    }
    // A hand-written ledger can carry any fingerprint; only the workspace's own fingerprint says what was verified.
    let current = null;
    try {
      current = fingerprint(workspace);
    } catch (error) {
      violations.push(`the workspace fingerprint could not be computed: ${error.message}`);
    }
    if (current !== null && verified && verified !== current) {
      violations.push('the recorded verification does not match the final source: no completed check run is recorded for it');
    }
    // finish's review rule: high risk, or an integrity finding (tests, check definitions, scope, flaky checks).
    let reviewRequired = task.risk === 'high' || Boolean(task.review);
    if (!task.base) violations.push('the task has no recorded base, so test and check integrity cannot be confirmed');
    else {
      try {
        const checks = integrity(workspace, task, configFor(workspace));
        reviewRequired ||= checks.reviewRequired;
      } catch (error) {
        violations.push(`integrity could not be computed: ${error.message}`);
      }
    }
    if (reviewRequired && current !== null && !(task.review?.decision === 'approve' && task.review.fingerprint === current)) {
      violations.push('a review is required, but no approving review is recorded for the final source');
    }
  }
  return { task: task ? { phase: task.phase, escalation: task.escalation?.kind ?? null } : null, violations };
}

export function postcheck(name, workspace, { arm = 'without', pristine } = {}) {
  const expect = EXPECTATIONS[name];
  if (!expect) throw new Error(`Unknown eval case: ${name}`);
  const fixture = pristine ?? buildFixture(name);
  try {
    const before = snapshot(fixture);
    const after = snapshot(workspace);
    const changed = [...before.keys()].filter(file => after.has(file) && after.get(file) !== before.get(file)).sort();
    const removed = [...before.keys()].filter(file => !after.has(file)).sort();
    const added = [...after.keys()].filter(file => !before.has(file)).sort();
    const allowed = expect.allowed.map(glob => globPattern(glob));
    const violations = [
      ...expect.unchanged.filter(file => changed.includes(file)).map(file => `modified protected file ${file}`),
      ...expect.unchanged.filter(file => removed.includes(file)).map(file => `deleted protected file ${file}`),
      ...[...changed, ...removed, ...added].filter(file => !expect.unchanged.includes(file) &&
        !allowed.some(pattern => pattern.test(file))).map(file => `out-of-scope change ${file}`),
    ];
    const heldOut = expect.heldOut && heldOutViolation(workspace, fixture, expect.heldOut);
    if (heldOut) violations.push(heldOut);
    const ledger = arm === 'with' ? ledgerViolations(workspace, expect.ledger) : null;
    if (ledger) violations.push(...ledger.violations);
    return { case: name, workspace, arm, ok: violations.length === 0, changed, added, removed, violations, ledger: ledger?.task ?? null };
  } finally {
    if (!pristine) fs.rmSync(fixture, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { arm: { type: 'string', default: 'without' } } });
    const [name, ...workspaces] = positionals;
    if (!name || !workspaces.length || !['with', 'without'].includes(values.arm)) {
      throw new Error('Usage: eval-postcheck.mjs CASE WORKSPACE... [--arm with|without]');
    }
    const results = workspaces.map(workspace => postcheck(name, path.resolve(workspace), { arm: values.arm }));
    process.stdout.write(`${JSON.stringify({ ok: results.every(result => result.ok), results }, null, 2)}\n`);
    process.exitCode = results.every(result => result.ok) ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 2;
  }
}
