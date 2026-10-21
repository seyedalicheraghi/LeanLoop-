import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fingerprint } from '../lib/git.mjs';
import { validateConfig } from '../lib/schema.mjs';
import { fixture, temporary, commit, git, cli, link, rootDirectory } from './helpers.mjs';

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
  if (!link(t, sentinel, path.join(root, '.leanloop/task.json'))) return;
  const result = cli(root, ['status']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), '{"untouched":true}');
});

test('nested directories are not mistaken for independent project roots', async t => {
  const root = await fixture(t);
  assert.throws(() => fingerprint(path.join(root, 'src')), /worktree root/);
});

test('a differently cased Windows path to the worktree root is accepted', { skip: process.platform !== 'win32' && 'Windows only' }, async t => {
  const root = await fixture(t);
  for (const variant of [root[0].toLowerCase() + root.slice(1), root.toUpperCase()]) {
    assert.equal(typeof fingerprint(variant), 'string');
    const doctor = cli(variant, ['doctor']);
    assert.equal(doctor.stderr, '', variant);
    assert.equal(JSON.parse(doctor.stdout).processCleanup, 'windows-process-tree');
  }
  assert.throws(() => fingerprint(path.join(root[0].toLowerCase() + root.slice(1), 'src')), /worktree root/);
});

test('malformed task state is an explicit error, not an empty new task', async t => {
  const root = await fixture(t);
  fs.writeFileSync(path.join(root, '.leanloop/task.json'), '{"version":99}');
  const result = cli(root, ['status']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid or unsupported task state/);
});

// validate-package rejects these characters in every shipped .mjs, .md, and .json file; catch them in npm test too.
test('package source contains no invisible or bidirectional Unicode characters', () => {
  // Numeric code points, so none of these characters appears literally in this file.
  const ranges = [[0xE0000, 0xE007F], [0x200B, 0x200D], [0x2060, 0x2060], [0x202A, 0x202E], [0x2066, 0x2069], [0xFEFF, 0xFEFF]];
  const hidden = { test: text => [...text].some(char => ranges.some(([low, high]) => char.codePointAt(0) >= low && char.codePointAt(0) <= high)) };
  const found = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', '.git', '.leanloop', 'dist'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(mjs|md|json)$/.test(entry.name) && hidden.test(fs.readFileSync(file, 'utf8'))) found.push(path.relative(rootDirectory, file));
    }
  };
  walk(rootDirectory);
  assert.deepEqual(found, []);
});
