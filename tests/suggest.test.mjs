import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { init } from '../lib/init.mjs';
import { suggestChecks } from '../lib/suggest.mjs';
import { temporary, git, cli, link } from './helpers.mjs';

test('doctor suggests real project commands but never configures them', async t => {
  const root = temporary(t);
  git(root, ['init', '--initial-branch=main']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }));
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[tool.pytest.ini_options]\naddopts = "-q"\n');
  await init(root);
  const before = fs.readFileSync(path.join(root, 'leanloop.json'), 'utf8');
  const result = cli(root, ['doctor']);
  assert.equal(result.status, 1, 'no configured checks is still not ready');
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.suggestedChecks.map(item => item.command.join(' ')), ['npm test', 'npm run lint', 'python3 -m pytest -q']);
  assert.match(report.suggestedChecks[0].addCheck, /^add-check test --timeout 600 -- npm test$/);
  assert.equal(fs.readFileSync(path.join(root, 'leanloop.json'), 'utf8'), before);
});

test('suggestions cover common stacks and stay empty when nothing is detected', t => {
  const empty = temporary(t);
  assert.deepEqual(suggestChecks(empty), []);
  const stacks = temporary(t);
  fs.writeFileSync(path.join(stacks, 'go.mod'), 'module example.com/x\n');
  fs.writeFileSync(path.join(stacks, 'MODULE.bazel'), 'module(name = "x")\n');
  fs.writeFileSync(path.join(stacks, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  const suggestions = suggestChecks(stacks);
  assert.deepEqual(suggestions.map(item => item.name), ['go-test', 'bazel-test']);
  const bazel = temporary(t);
  fs.writeFileSync(path.join(bazel, 'MODULE.bazel'), 'module(name = "x")\n');
  assert.match(suggestChecks(bazel)[0].why, /never \/\/\.\.\. by default/);
});

test('large lockfiles still select their package manager', t => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'x'.repeat(600 * 1024));
  assert.deepEqual(suggestChecks(root)[0].command, ['pnpm', 'test']);
});

test('suggestions honor packageManager and expose broken manifests instead of guessing', t => {
  const root = temporary(t);
  const manifest = path.join(root, 'package.json');
  fs.writeFileSync(manifest, '{"packageManager":"pnpm@10.0.0","scripts":{"test":"node --test"}}');
  assert.deepEqual(suggestChecks(root)[0].command, ['pnpm', 'test']);
  fs.writeFileSync(manifest, '{bad');
  assert.throws(() => suggestChecks(root), error => error.code === 'CORRUPT_DATA');
  fs.writeFileSync(manifest, '{"scripts":"invalid"}');
  assert.throws(() => suggestChecks(root), /scripts must be an object/);
});

test('suggestions reject ambiguous lockfiles and do not follow symlinks', t => {
  const root = temporary(t);
  const outside = temporary(t);
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"node --test"}}');
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
  fs.writeFileSync(path.join(root, 'yarn.lock'), '');
  assert.throws(() => suggestChecks(root), /Conflicting package-manager/);
  fs.unlinkSync(path.join(root, 'yarn.lock'));
  fs.unlinkSync(path.join(root, 'pnpm-lock.yaml'));
  fs.writeFileSync(path.join(outside, 'lock.yaml'), '');
  if (!link(t, path.join(outside, 'lock.yaml'), path.join(root, 'pnpm-lock.yaml'))) return;
  assert.throws(() => suggestChecks(root), /symlink/);
});
