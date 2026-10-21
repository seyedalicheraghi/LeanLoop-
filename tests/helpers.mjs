import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { init } from '../lib/init.mjs';
import { atomicJson } from '../lib/io.mjs';

export const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
export const cliPath = path.join(rootDirectory, 'leanloop.mjs');

export function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leanloop-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Directory links use junctions on Windows, which need no privilege; file links skip there without one.
export function link(t, target, location, type = 'file') {
  try {
    fs.symlinkSync(target, location, process.platform === 'win32' && type === 'dir' ? 'junction' : type);
    return true;
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('File symlinks on Windows need Developer Mode or administrator rights.');
    return false;
  }
}

export function git(root, args) {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Workflow Test', '-c', 'user.email=workflow@example.invalid', '-C', root, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
}

export async function fixture(t, checks = [{ name: 'test', command: [process.execPath, '-e', 'console.log("fixture passed")'] }]) {
  const root = temporary(t);
  git(root, ['init', '--initial-branch=main']);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/app.mjs'), 'export const answer = 42;\n');
  await init(root);
  atomicJson(root, 'leanloop.json', { version: 1, attemptLimit: 3, checks });
  return root;
}

export function commit(root) {
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'test: create isolated fixture\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>']);
}

export function cli(root, args) {
  return spawnSync(process.execPath, [cliPath, args[0], '--project', root, ...args.slice(1)], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
  });
}
