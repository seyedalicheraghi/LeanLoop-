import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fingerprint, ignoredDefinitionFiles } from '../lib/git.mjs';
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

test('ignored check definitions are found without walking dependency trees, within a bounded scan', async t => {
  const checks = [{ name: 'test', command: ['bash', 'build/run.sh'] }];
  const root = await fixture(t, checks);
  const write = (relative, content = '{}\n') => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  };
  write('.gitignore', 'node_modules/\ndata/\nbuild/\n.npmrc\n');
  // A large installed tree and a large dataset, both ignored.
  const dependencyFiles = 6000;
  for (let index = 0; index < dependencyFiles; index += 1) write(`node_modules/p${index % 40}/f${index}.js`, '');
  for (let index = 0; index < 3000; index += 1) write(`data/raw/s${index}.bin`, '');
  write('node_modules/p0/package.json');
  write('data/deep/x/conftest.py', '# ignored conftest\n');
  write('data/deep/Package.JSON');
  write('data/vendor/node_modules/pkg/package.json');
  write('data/clone/.git/HEAD', 'ref: refs/heads/main\n');
  write('data/clone/package.json');
  write('build/run.sh', 'exit 0\n');
  write('src/.npmrc', 'script-shell=true\n');
  const outside = temporary(t);
  fs.writeFileSync(path.join(outside, 'conftest.py'), '# outside\n');
  const linked = link(t, outside, path.join(root, 'data/linked'), 'dir');

  const trace = path.join(temporary(t), 'trace2.txt');
  const started = Date.now();
  process.env.GIT_TRACE2_PERF = trace;
  let found;
  try {
    found = ignoredDefinitionFiles(root, checks);
  } finally {
    delete process.env.GIT_TRACE2_PERF;
  }
  const elapsed = Date.now() - started;
  assert.deepEqual(found, ['build/run.sh', 'data/deep/Package.JSON', 'data/deep/x/conftest.py', 'src/.npmrc'],
    `linked: ${linked}`);
  assert.ok(elapsed < 10000, `scan took ${elapsed} ms`);
  // Git reports each ignored directory once instead of reading the paths inside it.
  const visited = [...fs.readFileSync(trace, 'utf8').matchAll(/paths-visited:(\d+)/g)].map(match => Number(match[1]));
  assert.ok(visited.length > 0, 'Git trace2 reports visited paths');
  assert.ok(Math.max(...visited) < 100, `Git visited ${Math.max(...visited)} paths`);
  // The scan budget counts the dataset (about 3000 entries) but none of the 6000-file dependency tree.
  assert.deepEqual(ignoredDefinitionFiles(root, checks, { maxEntries: 3100 }), found);
  // Past the budget, Git's own listing finds the same files (nested repositories and links still skipped).
  assert.deepEqual(ignoredDefinitionFiles(root, checks, { maxEntries: 2000 }), found);
  assert.equal(typeof fingerprint(root), 'string');
});

test('a large ignored dataset past the scan budget falls back to Git listing instead of failing', async t => {
  const checks = [{ name: 'test', command: ['bash', 'build/run.sh'] }];
  const root = await fixture(t, checks);
  const write = (relative, content = '{}\n') => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  };
  write('.gitignore', 'node_modules/\ndata/\nbuild/\n');
  for (let index = 0; index < 40; index += 1) write(`data/raw/s${index}.bin`, '');
  for (let index = 0; index < 40; index += 1) write(`node_modules/p${index % 4}/f${index}.js`, '');
  write('node_modules/p0/package.json');
  write('data/deep/x/conftest.py', '# ignored conftest\n');
  write('data/vendor/node_modules/pkg/package.json');
  write('build/run.sh', 'exit 0\n');
  const expected = ['build/run.sh', 'data/deep/x/conftest.py'];
  assert.deepEqual(ignoredDefinitionFiles(root, checks), expected);

  const trace = path.join(temporary(t), 'trace2.txt');
  process.env.GIT_TRACE2_PERF = trace;
  let found;
  try {
    found = ignoredDefinitionFiles(root, checks, { maxEntries: 10 });
  } finally {
    delete process.env.GIT_TRACE2_PERF;
  }
  assert.deepEqual(found, expected, 'over budget, the same definitions are found instead of an INVENTORY_LIMIT error');
  // The fallback is Git's full listing, which reads inside the ignored directories itself.
  const visited = [...fs.readFileSync(trace, 'utf8').matchAll(/paths-visited:(\d+)/g)].map(match => Number(match[1]));
  assert.ok(Math.max(...visited) >= 40, `Git visited ${Math.max(...visited)} paths`);
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
