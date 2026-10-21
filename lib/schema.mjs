import path from 'node:path';
import { integer, relativePath, requireThat, text } from './io.mjs';

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  attemptLimit: 3,
  checks: [],
});

// Files whose edits or deletion during a task need an independent review before finish (see SOURCES.md).
export const DEFAULT_TEST_PATHS = Object.freeze([
  '**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**', '**/*.test.*', '**/*.spec.*',
  '**/*_test.*', '**/test_*.py', '**/*Test.java', '**/*Tests.cs',
]);
// Files that define what a check command actually runs, matched case-insensitively because pytest, jest, and npm find
// them on case-insensitive filesystems. package.json and pyproject.toml count only for the parts that can change a
// run (see definitionDigest in tasks.mjs). Files a configured command names directly count too (checkArgumentPaths).
export const CHECK_DEFINITION_PATHS = Object.freeze([
  '**/package.json', '**/Makefile', '**/GNUmakefile', '**/pytest.ini', '**/.pytest.ini', '**/tox.ini', '**/setup.cfg',
  '**/conftest.py', '**/pyproject.toml', '**/noxfile.py', '**/jest.config.*', '**/vitest.config.*', '**/vitest.workspace.*',
  '**/vite.config.*', '**/playwright.config.*', '**/ava.config.*', '**/karma.conf.*', '**/.mocharc', '**/.mocharc.*',
  '**/.c8rc', '**/.c8rc.*', '**/.nycrc', '**/.nycrc.*', '**/.npmrc', '**/.yarnrc', '**/.yarnrc.yml', '**/bunfig.toml',
]);
// Installed dependencies are not scanned for ignored check definitions: every package carries a package.json, and
// tools such as tox rewrite them during a run. Edits there stay outside what LeanLoop can see.
export const DEPENDENCY_DIRECTORIES = Object.freeze(['**/node_modules/**', '**/site-packages/**', '**/dist-packages/**', '**/.tox/**', '**/.nox/**']);
const MAX_ARGUMENT_PATHS = 128;

// Project-relative POSIX paths that configured check commands name, such as ci/test.sh in ["bash", "ci/test.sh"].
// Flags and absolute paths are skipped; "--file=x" contributes x. Paths need not exist, so a deletion still counts.
export function checkArgumentPaths(checks) {
  const found = new Set();
  for (const check of Array.isArray(checks) ? checks : []) {
    const cwd = typeof check?.cwd === 'string' ? check.cwd.replaceAll('\\', '/') : '.';
    for (const argument of Array.isArray(check?.command) ? check.command : []) {
      if (typeof argument !== 'string' || found.size >= MAX_ARGUMENT_PATHS) continue;
      const value = (/^--?[\w-]+=(.+)$/.exec(argument)?.[1] ?? argument).replaceAll('\\', '/');
      if (!value || value.startsWith('-') || value.length > 1024 || /[\0\r\n]/.test(value)) continue;
      if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) continue;
      const joined = path.posix.normalize(path.posix.join(cwd, value)).replace(/\/+$/, '');
      if (!joined || joined === '.' || joined === '..' || joined.startsWith('../')) continue;
      found.add(joined);
    }
  }
  return [...found];
}

export const ESCALATION_KINDS = Object.freeze(['spec-conflict', 'test-conflict', 'budget-exhausted', 'missing-access', 'unclear-scope', 'other']);

export function globPattern(glob, { ignoreCase = false } = {}) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    if (glob.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 2;
    } else if (glob.startsWith('**', index)) {
      source += '.*';
      index += 1;
    } else if (glob[index] === '*') source += '[^/]*';
    else if (glob[index] === '?') source += '[^/]';
    else source += glob[index].replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, ignoreCase ? 'i' : '');
}

function fields(object, allowed, label) {
  requireThat(object && typeof object === 'object' && !Array.isArray(object), `${label} must be an object.`);
  const unknown = Object.keys(object).filter(key => !allowed.includes(key));
  requireThat(unknown.length === 0, `Unknown ${label} fields: ${unknown.join(', ')}`);
}

export function validateConfig(config) {
  fields(config, ['version', 'attemptLimit', 'checks', 'testPaths'], 'configuration');
  requireThat(config.version === 1, 'Unsupported configuration version.');
  integer(config.attemptLimit, 'attemptLimit', 1, 10);
  if (config.testPaths !== undefined) {
    requireThat(Array.isArray(config.testPaths) && config.testPaths.length <= 32, 'testPaths must be an array of at most 32 globs.');
    for (const glob of config.testPaths) {
      requireThat(typeof glob === 'string' && glob.length > 0 && glob.length <= 200 && !glob.startsWith('/') &&
        !glob.includes('\\') && !glob.split('/').includes('..'), 'testPaths entries must be relative POSIX globs.');
      requireThat(!/[{}[\]()]/.test(glob), `testPaths entry "${glob}" uses braces, brackets, or parentheses, ` +
        'which would match only literally; globs support only *, **, and ?. List each pattern separately.');
    }
  }
  requireThat(Array.isArray(config.checks) && config.checks.length <= 16, 'checks must be an array with at most 16 entries.');
  const names = new Set();
  for (const check of config.checks) {
    fields(check, ['name', 'command', 'cwd', 'timeoutSeconds', 'expectOutput'], 'check');
    requireThat(typeof check.name === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(check.name),
      'Check names must be lowercase identifiers of at most 40 characters.');
    requireThat(!names.has(check.name), `Duplicate check name: ${check.name}`);
    names.add(check.name);
    requireThat(Array.isArray(check.command) && check.command.length > 0 && check.command.length <= 64,
      `${check.name}: command must be a nonempty argument array.`);
    for (const argument of check.command) {
      requireThat(typeof argument === 'string' && argument.length <= 8192 && !argument.includes('\0'),
        `${check.name}: command arguments must be strings without null bytes.`);
    }
    text(check.command[0], 'Executable');
    relativePath(check.cwd ?? '.', 'Check cwd', true);
    integer(check.timeoutSeconds ?? 120, 'timeoutSeconds', 1, 3600);
    if (check.expectOutput !== undefined) text(check.expectOutput, 'expectOutput', 1000);
  }
  return config;
}

export function validateTask(task) {
  requireThat(task && task.version === 1, 'Invalid or unsupported task state.', 'CORRUPT_DATA');
  requireThat(typeof task.id === 'string' && /^[a-f0-9-]{36}$/.test(task.id), 'Invalid task identifier.', 'CORRUPT_DATA');
  text(task.goal, 'Task goal', 1000);
  text(task.owner, 'Task owner', 80);
  requireThat(['normal', 'high'].includes(task.risk), 'Invalid task risk.', 'CORRUPT_DATA');
  requireThat(['active', 'checking', 'blocked', 'done', 'cancelled'].includes(task.phase), 'Invalid task phase.', 'CORRUPT_DATA');
  if (task.activePid !== undefined) integer(task.activePid, 'Active owner PID', 1, 2 ** 31 - 1);
  integer(task.attempts, 'Task attempts', 0, 100);
  integer(task.attemptLimit, 'Task attempt limit', 1, 100);
  requireThat(Array.isArray(task.acceptance) && task.acceptance.length > 0 && task.acceptance.length <= 10,
    'Task must have 1-10 acceptance criteria.', 'CORRUPT_DATA');
  for (const item of task.acceptance) {
    text(item.text, 'Acceptance criterion', 500);
    requireThat(item.evidence === null || (typeof item.evidence?.text === 'string' &&
      typeof item.evidence?.fingerprint === 'string'), 'Invalid acceptance evidence.', 'CORRUPT_DATA');
  }
  requireThat(Array.isArray(task.scope) && task.scope.length <= 20, 'Invalid task scope.', 'CORRUPT_DATA');
  for (const scope of task.scope) relativePath(scope, 'Task scope');
  requireThat(Array.isArray(task.checkpoints) && task.checkpoints.length <= 10, 'Invalid checkpoint history.', 'CORRUPT_DATA');
  requireThat(Array.isArray(task.budgetChanges) && task.budgetChanges.length <= 10, 'Invalid budget history.', 'CORRUPT_DATA');
  requireThat(task.verification === null || (typeof task.verification?.fingerprint === 'string' &&
    Array.isArray(task.verification?.results)), 'Invalid verification state.', 'CORRUPT_DATA');
  // Tasks started before 0.5.0 have no base, history, or escalation.
  const manifest = task.base?.manifest;
  requireThat(task.base === undefined || ((task.base.head === null || /^[a-f0-9]{40,64}$/.test(task.base.head)) &&
    typeof task.base.configDigest === 'string' && (manifest === undefined || typeof manifest?.unavailable === 'string' ||
      (Number.isSafeInteger(manifest?.files) && typeof manifest?.digest === 'string'))), 'Invalid task base.', 'CORRUPT_DATA');
  const ignored = task.base?.ignoredDefinitions;
  requireThat(ignored === undefined || (Array.isArray(ignored) && ignored.length <= 1000 && ignored.every(entry =>
    Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && (entry[1] === null || typeof entry[1] === 'string'))),
  'Invalid ignored check-definition record.', 'CORRUPT_DATA');
  if (task.baselineRuns !== undefined) integer(task.baselineRuns, 'Baseline check runs', 0, 100);
  requireThat(task.history === undefined || (Array.isArray(task.history) && task.history.length <= 100), 'Invalid check history.', 'CORRUPT_DATA');
  requireThat(task.escalation === undefined || ESCALATION_KINDS.includes(task.escalation?.kind), 'Invalid escalation.', 'CORRUPT_DATA');
  const resolution = task.escalation?.resolution;
  requireThat(resolution === undefined || (typeof resolution?.decision === 'string' && resolution.decision.trim().length > 0 &&
    resolution.decision.length <= 1000 && typeof resolution.at === 'string'), 'Invalid escalation resolution.', 'CORRUPT_DATA');
  return task;
}
