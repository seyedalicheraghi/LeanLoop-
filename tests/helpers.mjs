import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { install } from '../lib/install.mjs';
import { atomicJson } from '../skills/leanloop/scripts/lib/io.mjs';

export const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
export const cliPath = path.join(rootDirectory, 'bin/leanloop.mjs');
export const SKILL_DIR = '.agents/skills/leanloop';

export function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leanloop-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
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
  await install(root);
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
