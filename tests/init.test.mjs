import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { init } from '../lib/init.mjs';
import { execute } from '../lib/cli.mjs';
import { temporary, git, link } from './helpers.mjs';

test('init creates only the check configuration and ignored state, idempotently', async t => {
  const root = temporary(t);
  git(root, ['init', '--initial-branch=main']);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Existing project rules.\n');
  const first = await init(root);
  assert.deepEqual(first.created.sort(), ['.leanloop/.gitignore', 'leanloop.json']);
  await execute(['add-check', 'test', '--project', root, '--', process.execPath, '-e', 'process.exit(0)']);
  const configured = fs.readFileSync(path.join(root, 'leanloop.json'), 'utf8');
  const second = await init(root);
  assert.deepEqual(second.created, []);
  assert.equal(second.preservedConfig, true);
  assert.equal(fs.readFileSync(path.join(root, 'leanloop.json'), 'utf8'), configured);
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), 'Existing project rules.\n');
  assert.equal(git(root, ['check-ignore', '.leanloop/task.json']).trim(), '.leanloop/task.json');
  assert.deepEqual(fs.readdirSync(root).sort(), ['.git', '.leanloop', 'CLAUDE.md', 'leanloop.json']);
});

test('dry-run reports the plan without writing anything', async t => {
  const root = temporary(t);
  const result = await init(root, true);
  assert.deepEqual(result.created.sort(), ['.leanloop/.gitignore', 'leanloop.json']);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('corrupt configuration and a changed state ignore file are refused, not overwritten', async t => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'leanloop.json'), '{bad');
  await assert.rejects(init(root), /Invalid JSON/);
  assert.equal(fs.existsSync(path.join(root, '.leanloop')), false);
  const other = temporary(t);
  fs.mkdirSync(path.join(other, '.leanloop'));
  fs.writeFileSync(path.join(other, '.leanloop/.gitignore'), 'task.json\n');
  await assert.rejects(init(other), /restore it/);
  assert.equal(fs.readFileSync(path.join(other, '.leanloop/.gitignore'), 'utf8'), 'task.json\n');
  assert.equal(fs.existsSync(path.join(other, 'leanloop.json')), false);
});

test('init refuses a symlinked state directory', async t => {
  const root = temporary(t);
  const outside = temporary(t);
  link(t, outside, path.join(root, '.leanloop'), 'dir');
  await assert.rejects(init(root), /symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('a pre-rename lean-workflow install is refused, not migrated or duplicated', async t => {
  for (const marker of ['.lean-workflow/install.json', 'lean-workflow.json']) {
    const root = temporary(t);
    fs.mkdirSync(path.join(root, path.dirname(marker)), { recursive: true });
    fs.writeFileSync(path.join(root, marker), '{"version":1}\n');
    const before = fs.readdirSync(root).sort();
    await assert.rejects(init(root), error => error.code === 'LEGACY_INSTALL' && error.message.includes(marker));
    await assert.rejects(init(root, true), error => error.code === 'LEGACY_INSTALL');
    assert.deepEqual(fs.readdirSync(root).sort(), before);
    assert.equal(fs.readFileSync(path.join(root, marker), 'utf8'), '{"version":1}\n');
  }
});

test('copies vendored by LeanLoop 0.4.0 are reported, never removed', async t => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, '.claude/skills/leanloop'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude/skills/leanloop/SKILL.md'), 'old copy');
  const result = await init(root);
  assert.deepEqual(result.vendoredCopies, ['.claude/skills/leanloop']);
  assert.match(result.warning, /duplicate the plugin/);
  assert.equal(fs.readFileSync(path.join(root, '.claude/skills/leanloop/SKILL.md'), 'utf8'), 'old copy');
});
