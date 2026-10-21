import { integer, relativePath, requireThat, text } from './io.mjs';

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  attemptLimit: 3,
  checks: [],
});

function fields(object, allowed, label) {
  requireThat(object && typeof object === 'object' && !Array.isArray(object), `${label} must be an object.`);
  const unknown = Object.keys(object).filter(key => !allowed.includes(key));
  requireThat(unknown.length === 0, `Unknown ${label} fields: ${unknown.join(', ')}`);
}

export function validateConfig(config) {
  fields(config, ['version', 'attemptLimit', 'checks'], 'configuration');
  requireThat(config.version === 1, 'Unsupported configuration version.');
  integer(config.attemptLimit, 'attemptLimit', 1, 10);
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
  return task;
}
