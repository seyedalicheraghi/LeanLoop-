import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { context, rankPaths, CONTEXT_BYTES } from '../lib/context.mjs';
import { fixture, cli } from './helpers.mjs';

test('100,000 candidate paths remain within the actual serialized output budget', () => {
  const paths = Array.from({ length: 100000 }, (_, index) => `packages/module-${index}/src/handler-${index}.ts`);
  const result = rankPaths(paths, 'handler module');
  assert.equal(result.scannedPaths, 100000);
  assert.equal(result.files.length, 12);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(`${JSON.stringify(result)}\n`) <= CONTEXT_BYTES);
});

test('very long multibyte filenames cannot exceed the byte budget', () => {
  const paths = Array.from({ length: 30 }, (_, index) => `src/handler-${index}-${'界'.repeat(1000)}.ts`);
  const result = rankPaths(paths, 'handler', [], 30);
  assert.ok(result.files.length < 30);
  assert.ok(Buffer.byteLength(`${JSON.stringify(result)}\n`) <= CONTEXT_BYTES);
});

test('scope filters and conservative sensitive-file exclusions apply before ranking', () => {
  const result = rankPaths(['src/auth.ts', 'test/auth.test.ts', '.env.auth', 'src/secret.key',
    'src/credentials-auth.json', 'node_modules/auth/index.js'], 'auth', ['src']);
  assert.deepEqual(result.files.map(file => file.path), ['src/auth.ts']);
});

test('no lexical match is explicit, not a fallback dump of unrelated files', () => {
  const result = rankPaths(['src/alpha.ts', 'test/beta.ts'], 'nomatch');
  assert.deepEqual(result.files, []);
  assert.equal(result.matchingPaths, 0);
});

test('context uses filenames without opening source contents', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'src/unreadable-handler.mjs');
  fs.writeFileSync(file, 'Private source content should not be read.');
  fs.chmodSync(file, 0o000);
  const result = context(root, 'handler', [], 12);
  assert.ok(result.files.some(item => item.path.endsWith('unreadable-handler.mjs')));
  assert.equal(JSON.stringify(result).includes('Private source'), false);
});

test('actual CLI output respects the same bound and rejects oversized limits', async t => {
  const root = await fixture(t);
  const result = cli(root, ['context', 'app']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout) <= CONTEXT_BYTES);
  assert.equal(JSON.parse(result.stdout).kind, 'filename-candidates');
  assert.notEqual(cli(root, ['context', 'app', '--limit', '999']).status, 0);
});
