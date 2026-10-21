import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fingerprint } from '../skills/leanloop/scripts/lib/git.mjs';
import { validateConfig } from '../skills/leanloop/scripts/lib/schema.mjs';
import { fixture, temporary, commit, git, cli } from './helpers.mjs';

test('configuration rejects escaping paths, shell strings, bad timeouts, and duplicate checks', () => {
  const valid = { name: 'test', command: ['node', '--test'] };
  const config = checks => ({ version: 1, attemptLimit: 3, checks });
  for (const cwd of ['../outside', '/outside', 'src/../../outside', 'C:\\outside', 'src//tests']) {
    assert.throws(() => validateConfig(config([{ ...valid, cwd }])), /path|Path|cwd/);
  }
  assert.throws(() => validateConfig(config([{ ...valid, command: 'node --test' }])), /argument array/);
  assert.throws(() => validateConfig(config([{ ...valid, timeoutSeconds: 0 }])), /timeoutSeconds/);
  assert.throws(() => validateConfig(config([{ ...valid, timeoutSeconds: 3601 }])), /timeoutSeconds/);
  assert.throws(() => validateConfig(config([valid, valid])), /Duplicate/);
  assert.throws(() => validateConfig({ ...config([]), attemptLimit: 0 }), /attemptLimit/);
});

test('oversized untracked data fails closed instead of excluding it silently', async t => {
  const root = await fixture(t);
  fs.writeFileSync(path.join(root, 'large-untracked.bin'), Buffer.alloc(16 * 1024 * 1024));
  assert.throws(() => fingerprint(root), /exceeds 16 MiB/);
});

test('submodule index entries fail with a concrete unsupported-layout error', async t => {
  const root = await fixture(t);
  commit(root);
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['update-index', '--add', '--cacheinfo', `160000,${head},nested-module`]);
  assert.throws(() => fingerprint(root), /submodules/);
});

test('symlinked state is not followed or overwritten', async t => {
  const root = await fixture(t);
  const outside = temporary(t);
  const sentinel = path.join(outside, 'sentinel.json');
  fs.writeFileSync(sentinel, '{"untouched":true}');
  fs.symlinkSync(sentinel, path.join(root, '.leanloop/task.json'));
  const result = cli(root, ['status']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), '{"untouched":true}');
});

test('nested directories are not mistaken for independent project roots', async t => {
  const root = await fixture(t);
  assert.throws(() => fingerprint(path.join(root, 'src')), /worktree root/);
});

test('malformed task state is an explicit error, not an empty new task', async t => {
  const root = await fixture(t);
  fs.writeFileSync(path.join(root, '.leanloop/task.json'), '{"version":99}');
  const result = cli(root, ['status']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid or unsupported task state/);
});
