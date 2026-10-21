import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { temporary, git, cli, SKILL_DIR } from './helpers.mjs';

test('installed CLI reproduces a real bug, validates the fix, and resumes across processes', t => {
  const root = temporary(t);
  git(root, ['init', '--initial-branch=main']);
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'src/pagination.mjs'), 'export const limit = value => value ?? 20;\n');
  fs.writeFileSync(path.join(root, 'tests/pagination.test.mjs'), `
import assert from 'node:assert/strict';
import test from 'node:test';
import { limit } from '../src/pagination.mjs';
test('negative limits are rejected', () => assert.throws(() => limit(-1), RangeError));
test('valid and default limits are preserved', () => {
  assert.equal(limit(2), 2);
  assert.equal(limit(undefined), 20);
});
`);
  const install = cli(root, ['init']);
  assert.equal(install.status, 0, install.stderr);
  const added = cli(root, ['add-check', 'unit', '--expect-output', '# tests 2',
    '--', process.execPath, '--test', 'tests/pagination.test.mjs']);
  assert.equal(added.status, 0, added.stderr);

  const runtime = path.join(root, SKILL_DIR, 'scripts/workflow.mjs');
  function invoke(args, expected = 0) {
    const result = spawnSync(process.execPath, [runtime, args[0], '--project', root, ...args.slice(1)], {
      encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.status, expected, result.stderr || result.stdout);
    return JSON.parse(result.stdout || result.stderr);
  }
  invoke(['start', 'Reject negative pagination limits', '--accept', 'Negative limits raise RangeError',
    '--accept', 'Valid limits and the default are unchanged', '--risk', 'high', '--scope', 'src']);
  const red = invoke(['check'], 1);
  assert.equal(red.results[0].exitCode, 1, JSON.stringify({
    result: red,
    stderr: fs.readFileSync(path.join(root, red.results[0].stderrLog), 'utf8').slice(0, 1000),
    stdout: fs.readFileSync(path.join(root, red.results[0].stdoutLog), 'utf8').slice(0, 1000),
  }));
  invoke(['checkpoint', 'Regression reproduced with the negative-limit test.',
    '--next', 'Add a negative-value guard without changing defaults.']);
  assert.match(invoke(['status']).next.summary, /Regression reproduced/);

  fs.writeFileSync(path.join(root, 'src/pagination.mjs'),
    'export function limit(value) { if (value < 0) throw new RangeError("negative limit"); return value ?? 20; }\n');
  const green = invoke(['check']);
  assert.equal(green.ok, true);
  assert.equal(green.results[0].expectedOutputFound, true);
  invoke(['prove', '1', `Negative-limit regression failed before and passed after the guard. Log: ${green.results[0].stdoutLog}`]);
  invoke(['prove', '2', 'The valid/default limit test passed before and after the change.']);
  invoke(['finish'], 2);
  invoke(['review', '--by', 'fixture-independent-review', '--decision', 'approve',
    '--evidence', 'Synthetic review attestation for integration-test purposes.']);
  assert.equal(invoke(['finish']).phase, 'done');
  assert.equal(invoke(['status']).verification.fresh, true);
  assert.equal(fs.existsSync(path.join(root, '.leanloop/lock.json')), false);
});
