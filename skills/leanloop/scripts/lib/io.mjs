import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const STATE_DIR = '.leanloop';
export const CONFIG_FILE = 'leanloop.json';
export const MAX_JSON_BYTES = 256 * 1024;

export class WorkflowError extends Error {
  constructor(message, code = 'INVALID_INPUT') {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

export function requireThat(condition, message, code) {
  if (!condition) throw new WorkflowError(message, code);
}

export function text(value, label, limit = 1000) {
  requireThat(typeof value === 'string' && value.trim().length > 0, `${label} must be nonempty text.`);
  requireThat(value.length <= limit && !value.includes('\0'), `${label} exceeds its limit or contains a null byte.`);
  return value.trim();
}

export function integer(value, label, minimum, maximum) {
  requireThat(Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${label} must be an integer between ${minimum} and ${maximum}.`);
  return value;
}

export function relativePath(value, label = 'Path', allowRoot = false) {
  text(value, label, 4096);
  if (allowRoot && value === '.') return value;
  requireThat(!path.isAbsolute(value) && !/^[a-z]:/i.test(value) && !value.includes('\\'),
    `${label} must be a project-relative path using forward slashes.`);
  requireThat(value.split('/').every(part => part && part !== '.' && part !== '..'),
    `${label} must not contain empty, "." or ".." components.`);
  return value;
}

export function projectRoot(value = process.cwd()) {
  const absolute = path.resolve(value);
  requireThat(fs.existsSync(absolute), `Project does not exist: ${absolute}`);
  requireThat(!fs.lstatSync(absolute).isSymbolicLink(), 'Select the real project directory, not a symlink.');
  requireThat(fs.statSync(absolute).isDirectory(), 'Project must be a directory.');
  return fs.realpathSync(absolute);
}

export function safePath(root, relative) {
  relativePath(relative);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      requireThat(!fs.lstatSync(current).isSymbolicLink(), `Refusing a symlink in managed path: ${relative}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return current;
}

export function optionalStat(root, relative) {
  try {
    return fs.lstatSync(safePath(root, relative));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function readOptionalText(root, relative, maxBytes) {
  const stat = optionalStat(root, relative);
  if (!stat) return null;
  requireThat(stat.isFile(), `Expected a regular file: ${relative}`);
  requireThat(stat.size <= maxBytes, `${relative} exceeds the ${maxBytes}-byte read limit.`, 'READ_LIMIT');
  const contents = fs.readFileSync(safePath(root, relative), 'utf8');
  requireThat(Buffer.byteLength(contents) <= maxBytes, `${relative} grew beyond the read limit.`, 'READ_LIMIT');
  return contents;
}

export function ensureDirectory(root, relative) {
  if (relative === '.') return root;
  const target = safePath(root, relative);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

export function readJson(root, relative, optional = false) {
  const target = safePath(root, relative);
  let contents;
  try {
    requireThat(fs.statSync(target).isFile(), `Expected a regular JSON file: ${relative}`);
    requireThat(fs.statSync(target).size <= MAX_JSON_BYTES, `JSON file is too large: ${relative}`);
    contents = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error.code === 'ENOENT') {
      throw new WorkflowError(`Missing ${relative}.${relative === CONFIG_FILE ? ' Run init first.' : ''}`, 'NOT_INITIALIZED');
    }
    throw error;
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new WorkflowError(`Invalid JSON in ${relative}: ${error.message}`, 'CORRUPT_DATA');
  }
}

export function atomicJson(root, relative, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  requireThat(Buffer.byteLength(content) <= MAX_JSON_BYTES, `${relative} exceeds the state size limit.`);
  atomicFile(root, relative, content);
}

export function atomicFile(root, relative, content, { exclusive = false, mode = 0o600 } = {}) {
  ensureDirectory(root, path.posix.dirname(relative));
  const target = safePath(root, relative);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const fd = fs.openSync(temporary, 'wx', mode);
    created = true;
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (exclusive) fs.linkSync(temporary, target);
    else {
      fs.renameSync(temporary, target);
      created = false;
    }
  } finally {
    if (created) fs.unlinkSync(temporary);
  }
}

export async function withLock(root, action) {
  ensureDirectory(root, STATE_DIR);
  const lock = safePath(root, `${STATE_DIR}/lock.json`);
  try {
    // Publish complete metadata atomically without replacing another owner's lock.
    atomicFile(root, `${STATE_DIR}/lock.json`,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { exclusive: true });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new WorkflowError('A project lock already exists. Inspect status before an explicit recovery; do not delete the lock blindly.', 'LOCKED');
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    fs.unlinkSync(lock);
  }
}

export function inspectLock(root) {
  let lock;
  try {
    lock = readJson(root, `${STATE_DIR}/lock.json`, true);
  } catch (error) {
    if (error.code !== 'CORRUPT_DATA') throw error;
    return { invalid: true, error: error.message };
  }
  if (lock === null) return null;
  if (!Number.isSafeInteger(lock?.pid) || lock.pid < 1 || lock.pid >= 2 ** 31) {
    return { invalid: true, error: 'Lock owner PID is missing or invalid.' };
  }
  return lock;
}

function requireDeadOwner(pid) {
  if (pid === undefined) return;
  integer(pid, 'Owner PID', 1, 2 ** 31 - 1);
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== 'ESRCH') throw new WorkflowError(`Cannot prove the lock owner has exited: ${error.message}`);
    return;
  }
  throw new WorkflowError('The recorded owner is still running. Do not steal its lock.', 'LOCKED');
}

export function recoverLock(root, { ownerPid, unlocked = false, broken = false, reason, activePid }) {
  requireThat([ownerPid !== undefined, unlocked, broken].filter(Boolean).length === 1,
    'Choose exactly one recovery mode: --owner-pid, --unlocked, or --broken-lock.');
  requireDeadOwner(activePid);
  const lock = inspectLock(root);
  if (unlocked) {
    text(reason, 'Recovery reason', 500);
    requireThat(lock === null, 'A lock exists; --unlocked cannot remove it.');
    return { recovered: true, mode: 'missing-lock', reason };
  }
  if (broken) {
    text(reason, 'Recovery reason', 500);
    requireThat(lock?.invalid === true, '--broken-lock applies only to an invalid owner record, not a valid live lock.');
    ensureDirectory(root, `${STATE_DIR}/recovery`);
    const quarantine = `${STATE_DIR}/recovery/lock-${randomUUID()}.json`;
    fs.renameSync(safePath(root, `${STATE_DIR}/lock.json`), safePath(root, quarantine));
    return {
      recovered: true, mode: 'invalid-lock', reason, quarantine,
      warning: 'Operator-confirmed recovery: an invalid lock cannot prove no unrecorded owner exists.',
    };
  }
  integer(ownerPid, 'Owner PID', 1, 2 ** 31 - 1);
  requireThat(lock && !lock.invalid, 'No valid lock owner is available. Inspect status and select an explicit recovery mode.');
  requireThat(lock.pid === ownerPid, 'Owner PID does not match the lock; no state was changed.');
  requireDeadOwner(ownerPid);
  fs.unlinkSync(safePath(root, `${STATE_DIR}/lock.json`));
  return { recovered: true, mode: 'dead-owner', ownerPid };
}
