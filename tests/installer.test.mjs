import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { install } from '../lib/install.mjs';
import { execute } from '../skills/leanloop/scripts/lib/cli.mjs';
import { atomicJson, readJson } from '../skills/leanloop/scripts/lib/io.mjs';
import { temporary, git, fixture, cli, SKILL_DIR } from './helpers.mjs';

test('installation is idempotent and preserves unrelated instructions and configured checks', async t => {
  const root = temporary(t);
  git(root, ['init', '--initial-branch=main']);
  fs.mkdirSync(path.join(root, '.github'));
  const existing = path.join(root, '.github/copilot-instructions.md');
  fs.writeFileSync(existing, 'Existing project rules.\n');
  const first = await install(root);
  assert.ok(first.created.length >= 10);
  await execute(['add-check', 'test', '--project', root, '--', process.execPath, '-e', 'process.exit(0)']);
  const configured = fs.readFileSync(path.join(root, 'leanloop.json'), 'utf8');
  const second = await install(root);
  assert.deepEqual(second.created, []);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'Existing project rules.\n');
  assert.equal(fs.readFileSync(path.join(root, 'leanloop.json'), 'utf8'), configured);
  assert.equal(git(root, ['check-ignore', '.leanloop/task.json']).trim(), '.leanloop/task.json');
});

test('conflicting customizations fail preflight without writing configuration', async t => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, SKILL_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, SKILL_DIR, 'SKILL.md'), 'Do not overwrite.');
  await assert.rejects(install(root), /Refusing to overwrite/);
  assert.equal(fs.existsSync(path.join(root, 'leanloop.json')), false);
  assert.equal(fs.readFileSync(path.join(root, SKILL_DIR, 'SKILL.md'), 'utf8'), 'Do not overwrite.');
});

test('dry-run does not create files or directories', async t => {
  const root = temporary(t);
  const result = await install(root, true);
  assert.equal(result.dryRun, true);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('installer refuses symlinked customization ancestors', async t => {
  const root = temporary(t);
  const outside = temporary(t);
  fs.symlinkSync(outside, path.join(root, '.github'), 'dir');
  await assert.rejects(install(root), /symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('installer refuses corrupt existing configuration', async t => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'leanloop.json'), '{bad');
  await assert.rejects(install(root), /Invalid JSON/);
  assert.equal(fs.existsSync(path.join(root, '.github')), false);
});

test('a pre-rename lean-workflow install is refused, not migrated or duplicated', async t => {
  for (const marker of ['.lean-workflow/install.json', 'lean-workflow.json']) {
    const root = temporary(t);
    fs.mkdirSync(path.join(root, path.dirname(marker)), { recursive: true });
    fs.writeFileSync(path.join(root, marker), '{"version":1}\n');
    const before = fs.readdirSync(root).sort();
    await assert.rejects(install(root), error => error.code === 'LEGACY_INSTALL' && error.message.includes(marker));
    await assert.rejects(install(root, true), error => error.code === 'LEGACY_INSTALL');
    assert.deepEqual(fs.readdirSync(root).sort(), before);
    assert.equal(fs.readFileSync(path.join(root, marker), 'utf8'), '{"version":1}\n');
  }
});

test('copied runtime is self-contained and does not need the original package', async t => {
  const root = await fixture(t);
  const { spawnSync } = await import('node:child_process');
  const runtime = path.join(root, SKILL_DIR, 'scripts/workflow.mjs');
  const result = spawnSync(process.execPath, [runtime, 'doctor', '--project', root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test('CLI rejects unknown flags and reports missing configuration nonzero', t => {
  const root = temporary(t);
  assert.notEqual(cli(root, ['status']).status, 0);
  const result = cli(root, ['status', '--typo']);
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stderr).ok, false);
});

test('doctor reports an unconfigured project as not ready', async t => {
  const root = temporary(t);
  git(root, ['init', '--initial-branch=main']);
  await install(root);
  const result = cli(root, ['doctor']);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).configuredChecks, []);
});

test('explicit upgrades replace registered unchanged old assets and preserve project configuration', async t => {
  const root = await fixture(t);
  const relative = `${SKILL_DIR}/scripts/workflow.mjs`;
  const installed = path.join(root, relative);
  const oldContent = 'previous independently registered runtime\n';
  fs.writeFileSync(installed, oldContent);
  const registry = readJson(root, '.leanloop/install.json');
  registry.packageVersion = '0.0.0';
  registry.files[relative] = createHash('sha256').update(oldContent).digest('hex');
  atomicJson(root, '.leanloop/install.json', registry);
  const config = fs.readFileSync(path.join(root, 'leanloop.json'), 'utf8');
  await assert.rejects(install(root), /--upgrade/);
  const preview = await install(root, true, true);
  assert.ok(preview.files.some(file => file.path === relative && file.action === 'replace'));
  assert.equal(fs.readFileSync(installed, 'utf8'), oldContent);
  const result = await install(root, false, true);
  assert.ok(result.updated.includes(relative));
  assert.match(fs.readFileSync(installed, 'utf8'), /runCli/);
  assert.equal(fs.readFileSync(path.join(root, 'leanloop.json'), 'utf8'), config);
});

test('upgrade refuses user edits even when an installation registry exists', async t => {
  const root = await fixture(t);
  const installed = path.join(root, SKILL_DIR, 'SKILL.md');
  fs.appendFileSync(installed, '\nA deliberate local customization.\n');
  const before = fs.readFileSync(installed, 'utf8');
  await assert.rejects(install(root, false, true), /Refusing to overwrite/);
  assert.equal(fs.readFileSync(installed, 'utf8'), before);
});

test('upgrade removes only retired files with matching registered contents', async t => {
  const root = await fixture(t);
  const relative = `${SKILL_DIR}/scripts/retired.mjs`;
  const content = 'export const retired = true;\n';
  fs.writeFileSync(path.join(root, relative), content);
  const registry = readJson(root, '.leanloop/install.json');
  registry.files[relative] = createHash('sha256').update(content).digest('hex');
  atomicJson(root, '.leanloop/install.json', registry);
  await assert.rejects(install(root), /Retired managed file/);
  const result = await install(root, false, true);
  assert.deepEqual(result.removed, [relative]);
  assert.equal(fs.existsSync(path.join(root, relative)), false);
});

test('default installation uses the portable skill location shared by Copilot, Codex, and Gemini CLI', async t => {
  const root = temporary(t);
  git(root, ['init', '--initial-branch=main']);
  const result = await install(root);
  assert.deepEqual(result.hosts, ['portable']);
  assert.ok(fs.existsSync(path.join(root, '.agents/skills/leanloop/SKILL.md')));
  assert.ok(fs.existsSync(path.join(root, '.github/agents/leanloop-reviewer.agent.md')));
  assert.equal(fs.existsSync(path.join(root, '.github/skills')), false);
  assert.deepEqual(readJson(root, '.leanloop/install.json').hosts, ['portable']);
});

test('the claude host installs its skill folder and a Claude-format read-only reviewer', async t => {
  const root = temporary(t);
  const result = await execute(['init', '--project', root, '--host', 'claude'], install);
  assert.deepEqual(result.hosts, ['claude']);
  assert.ok(fs.existsSync(path.join(root, '.claude/skills/leanloop/scripts/workflow.mjs')));
  const reviewer = fs.readFileSync(path.join(root, '.claude/agents/leanloop-reviewer.md'), 'utf8');
  assert.match(reviewer, /^tools: Read, Grep, Glob$/m);
  assert.equal(fs.existsSync(path.join(root, '.github')), false);
  await assert.rejects(execute(['init', '--project', root, '--host', 'cursor'], install), /Unknown host "cursor"/);
});

test('a 0.1.0-style install keeps its layout until an explicit host migration', async t => {
  const root = temporary(t);
  git(root, ['init', '--initial-branch=main']);
  await install(root, false, false, ['copilot']);
  await execute(['add-check', 'unit', '--project', root, '--', process.execPath, '-e', '0']);
  const config = fs.readFileSync(path.join(root, 'leanloop.json'), 'utf8');
  const registry = readJson(root, '.leanloop/install.json');
  delete registry.hosts;
  atomicJson(root, '.leanloop/install.json', registry);
  const kept = await install(root);
  assert.deepEqual(kept.hosts, ['copilot']);
  assert.ok(fs.existsSync(path.join(root, '.github/skills/leanloop/SKILL.md')));
  assert.equal(fs.existsSync(path.join(root, '.agents')), false);
  await assert.rejects(install(root, false, false, ['portable']), /Retired managed file/);
  const migrated = await install(root, false, true, ['portable']);
  assert.ok(migrated.created.includes('.agents/skills/leanloop/SKILL.md'));
  assert.ok(migrated.removed.includes('.github/skills/leanloop/SKILL.md'));
  assert.equal(fs.existsSync(path.join(root, '.github/skills/leanloop')), false);
  assert.ok(fs.existsSync(path.join(root, '.github/agents/leanloop-reviewer.agent.md')));
  assert.equal(fs.readFileSync(path.join(root, 'leanloop.json'), 'utf8'), config);
});

test('a registry with an empty host list is rejected instead of retiring every managed file', async t => {
  const root = await fixture(t);
  const registry = readJson(root, '.leanloop/install.json');
  registry.hosts = [];
  atomicJson(root, '.leanloop/install.json', registry);
  await assert.rejects(install(root, false, true), /Invalid hosts in installation registry/);
  assert.ok(fs.existsSync(path.join(root, SKILL_DIR, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(root, '.github/agents/leanloop-reviewer.agent.md')));
});
