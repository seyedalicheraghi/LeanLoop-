import assert from 'node:assert/strict';
import test from 'node:test';
import { checkIndexListing } from '../lib/git.mjs';

const sha = 'a'.repeat(40);
const entry = (file, { flag = 'H', mode = '100644', stage = '0' } = {}) => `${flag} ${mode} ${sha} ${stage}\t${file}\0`;

test('index listings larger than the old 16 MiB cap are checked without decoding one giant string', () => {
  const records = Array.from({ length: 200000 }, (_, index) => entry(`packages/module-${index}/src/a file\twith tab-${index}.ts`));
  const listing = Buffer.from(records.join(''));
  assert.ok(listing.length > 16 * 1024 * 1024);
  const started = performance.now();
  checkIndexListing(listing);
  assert.ok(performance.now() - started < 5000, 'large index check stays fast');
  assert.throws(() => checkIndexListing(Buffer.concat([listing, Buffer.from(entry('late/skip.ts', { flag: 'S' }))])), /skip-worktree/);
});

test('every unsafe index entry still fails closed', () => {
  checkIndexListing(Buffer.alloc(0));
  checkIndexListing(Buffer.from(entry('ok.ts') + entry('dir/ok two.ts', { mode: '100755' })));
  assert.throws(() => checkIndexListing(Buffer.from(entry('hidden.ts', { flag: 'h' }))), /assume-unchanged/);
  assert.throws(() => checkIndexListing(Buffer.from(entry('vendor/lib', { mode: '160000' }))), /submodules/);
  assert.throws(() => checkIndexListing(Buffer.from(entry('conflict.ts', { flag: 'M', stage: '2' }))), /merge conflicts/);
  assert.throws(() => checkIndexListing(Buffer.concat([Buffer.from(`H 100644 ${sha} 0\t`), Buffer.from([0xff, 0xfe]), Buffer.from('\0')])),
    error => error.code === 'UNSUPPORTED_PATH');
});
