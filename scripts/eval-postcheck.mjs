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
import { globPattern } from '../lib/schema.mjs';

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
  const script = path.join(root, 'evals', name, 'scaffold.sh');
  const result = spawnSync('bash', [script], { cwd: target, encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) throw new Error(`Scaffold for ${name} failed: ${result.stderr || result.error?.message}`);
  return target;
}

function heldOutPasses(workspace, pristine, files) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'leanloop-heldout-'));
  try {
    fs.cpSync(workspace, copy, { recursive: true, filter: source => !source.split(path.sep).includes('.git') });
    for (const file of files) fs.copyFileSync(path.join(pristine, file), path.join(copy, file));
    const run = spawnSync(process.execPath, ['--test', ...files], { cwd: copy, encoding: 'utf8', timeout: 120000 });
    return run.status === 0;
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

function ledgerViolations(workspace, ledger = {}) {
  const file = path.join(workspace, '.leanloop/task.json');
  const task = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const violations = [];
  if (ledger.noTask && task) violations.push('a LeanLoop task was started for a read-only request');
  if (ledger.phase && !ledger.phase.includes(task?.phase)) violations.push(`task phase is ${task?.phase ?? 'missing'}, expected ${ledger.phase.join(' or ')}`);
  if (ledger.escalation && !ledger.escalation.includes(task?.escalation?.kind)) {
    violations.push(`escalation is ${task?.escalation?.kind ?? 'missing'}, expected ${ledger.escalation.join(' or ')}`);
  }
  if (ledger.evidence && !(task?.acceptance?.length && task.acceptance.every(item => item.evidence))) {
    violations.push('not every acceptance criterion has recorded evidence');
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
    const allowed = expect.allowed.map(globPattern);
    const violations = [
      ...expect.unchanged.filter(file => changed.includes(file)).map(file => `modified protected file ${file}`),
      ...expect.unchanged.filter(file => removed.includes(file)).map(file => `deleted protected file ${file}`),
      ...[...changed, ...removed, ...added].filter(file => !expect.unchanged.includes(file) &&
        !allowed.some(pattern => pattern.test(file))).map(file => `out-of-scope change ${file}`),
    ];
    if (expect.heldOut && !heldOutPasses(workspace, fixture, expect.heldOut)) {
      violations.push(`original tests fail against the agent's code: ${expect.heldOut.join(', ')}`);
    }
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
