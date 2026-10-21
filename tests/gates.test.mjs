import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  checkpoint, escalate, finish, recordProof, recordReview, resume, startTask, status, verify,
} from '../lib/tasks.mjs';
import { globPattern, validateConfig, validateTask } from '../lib/schema.mjs';
import { atomicJson, readJson } from '../lib/io.mjs';
import { fingerprint } from '../lib/git.mjs';
import { fixture, commit, cli } from './helpers.mjs';

const request = { goal: 'Keep the answer', criteria: ['The answer is 42'] };

async function committed(t, checks) {
  const root = await fixture(t, checks);
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests/app.test.mjs'), 'assert(answer === 42);\n');
  commit(root);
  return root;
}

async function readyToFinish(root) {
  assert.equal((await verify(root)).ok, true);
  await recordProof(root, 1, 'Fixture check passed on the final source.');
}

test('editing, deleting, or committing a change to an existing test requires review before finish', async t => {
  const test = 'tests/app.test.mjs';
  for (const change of [
    root => fs.writeFileSync(path.join(root, test), 'weakened();\n'),
    root => fs.unlinkSync(path.join(root, test)),
    root => {
      fs.writeFileSync(path.join(root, test), 'weakened();\n');
      commit(root);
    },
  ]) {
    const root = await committed(t);
    await startTask(root, request);
    change(root);
    await readyToFinish(root);
    await assert.rejects(finish(root), error => error.code === 'INTEGRITY_REVIEW_REQUIRED' && error.message.includes(test));
    assert.equal(status(root).integrity.reviewRequired, true);
    await recordReview(root, 'independent-reviewer', 'approve', 'Reviewed the test change against the specification.');
    assert.equal((await finish(root)).phase, 'done');
  }
});

test('new tests and ordinary source edits finish without an integrity review', async t => {
  const root = await committed(t);
  await startTask(root, request);
  fs.writeFileSync(path.join(root, 'tests/new.test.mjs'), 'assert(true);\n');
  fs.writeFileSync(path.join(root, 'src/app.mjs'), 'export const answer = 42; // unchanged value\n');
  await readyToFinish(root);
  const done = await finish(root);
  assert.equal(done.phase, 'done');
  assert.deepEqual(done.integrity.testFiles, []);
  assert.equal(done.integrity.checkConfigChanged, false);
});

test('changing the configured checks during a task requires review', async t => {
  const root = await committed(t);
  await startTask(root, request);
  const config = readJson(root, 'leanloop.json');
  config.checks[0].command = [process.execPath, '-e', '0'];
  atomicJson(root, 'leanloop.json', config);
  await readyToFinish(root);
  await assert.rejects(finish(root), error => error.code === 'INTEGRITY_REVIEW_REQUIRED' && /check configuration/.test(error.message));
  assert.equal(status(root).integrity.checkConfigChanged, true);
});

test('testPaths decides which files count as tests', async t => {
  const root = await committed(t);
  const config = readJson(root, 'leanloop.json');
  config.testPaths = ['checks/**'];
  atomicJson(root, 'leanloop.json', config);
  commit(root);
  await startTask(root, request);
  fs.writeFileSync(path.join(root, 'tests/app.test.mjs'), 'not a configured test path\n');
  await readyToFinish(root);
  assert.equal((await finish(root)).phase, 'done');
});

test('test path globs match nested and root paths without partial-name matches', () => {
  const matches = (glob, file) => globPattern(glob).test(file);
  assert.equal(matches('**/tests/**', 'tests/a.mjs'), true);
  assert.equal(matches('**/tests/**', 'pkg/tests/deep/a.mjs'), true);
  assert.equal(matches('**/*.test.*', 'src/a.test.ts'), true);
  assert.equal(matches('**/*.test.*', 'src/attest.ts'), false);
  assert.equal(matches('**/test_*.py', 'test_api.py'), true);
  assert.equal(matches('**/tests/**', 'contests/a.mjs'), false);
  for (const bad of [['../x'], ['/abs/**'], ['a\\b'], 'tests/**']) {
    assert.throws(() => validateConfig({ version: 1, attemptLimit: 3, checks: [], testPaths: bad }), /testPaths/);
  }
});

test('testPaths rejects brace, bracket, and parenthesis globs that would match only literally', () => {
  const config = testPaths => ({ version: 1, attemptLimit: 3, checks: [], testPaths });
  for (const bad of ['**/*.{js,ts}', 'test[s]/**', '(unit)/**', 'a}b']) {
    assert.throws(() => validateConfig(config([bad])), /only \*, \*\*, and \?/);
  }
  assert.doesNotThrow(() => validateConfig(config(['**/*.test.?s', 'checks/**'])));
});

test('escalation blocks the task with a structured record for the user', async t => {
  const root = await fixture(t);
  await startTask(root, request);
  await assert.rejects(escalate(root, 'giving-up', 'x', 'y', 'z'), /Escalation kind/);
  const result = await escalate(root, 'test-conflict', 'The test expects 41 but the specification says 42.',
    'Read the specification and the test; ran the check twice.', 'Confirm which value is correct.');
  assert.equal(result.phase, 'blocked');
  assert.equal(status(root).escalation.kind, 'test-conflict');
  assert.match(status(root).escalation.recommendation, /Confirm/);
  assert.equal(status(root).escalation.resolved, false);
});

test('an escalation stops finish until the user decision is recorded with resume', async t => {
  const root = await fixture(t);
  await startTask(root, request);
  await assert.rejects(resume(root, 'Nothing to decide.'), /no unresolved escalation/);
  await escalate(root, 'test-conflict', 'The test expects 41 but the specification says 42.',
    'Read the specification and the test.', 'Confirm which value is correct.');
  // A passing check and complete evidence do not answer the escalated question.
  await readyToFinish(root);
  assert.equal(status(root).phase, 'blocked');
  await assert.rejects(finish(root), error => error.code === 'ESCALATED');
  assert.equal(status(root).phase, 'blocked');
  assert.equal(cli(root, ['resume']).status, 2);
  const resumed = cli(root, ['resume', '--decision', 'The specification wins: keep 42.']);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).phase, 'active');
  const reported = status(root).escalation;
  assert.equal(reported.resolved, true);
  assert.equal(reported.resolution.decision, 'The specification wins: keep 42.');
  await assert.rejects(resume(root, 'Again.'), /no unresolved escalation/);
  assert.equal((await finish(root)).phase, 'done');
  assert.equal(readJson(root, '.leanloop/task.json').escalation.kind, 'test-conflict');
});

test('task validation rejects a malformed escalation resolution', async t => {
  const root = await fixture(t);
  await startTask(root, request);
  await escalate(root, 'other', 'Unclear.', 'Asked.', 'Decide.');
  const task = readJson(root, '.leanloop/task.json');
  for (const resolution of [{ decision: '' }, { decision: 'ok' }, 'ok', { decision: 'x'.repeat(1001), at: 'now' }]) {
    assert.throws(() => validateTask({ ...task, escalation: { ...task.escalation, resolution } }), /resolution/);
  }
  assert.doesNotThrow(() => validateTask({ ...task, escalation: { ...task.escalation, resolution: { decision: 'ok', at: 'now' } } }));
});

test('without a base commit, edited or deleted tests and weakened checks still require review', async t => {
  for (const change of [
    root => fs.writeFileSync(path.join(root, 'tests/app.test.mjs'), 'weakened();\n'),
    root => fs.unlinkSync(path.join(root, 'tests/app.test.mjs')),
    root => {
      const config = readJson(root, 'leanloop.json');
      config.checks[0].command = [process.execPath, '-e', '0'];
      atomicJson(root, 'leanloop.json', config);
    },
  ]) {
    const root = await fixture(t);
    fs.mkdirSync(path.join(root, 'tests'));
    fs.writeFileSync(path.join(root, 'tests/app.test.mjs'), 'assert(answer === 42);\n');
    await startTask(root, request);
    assert.equal(readJson(root, '.leanloop/task.json').base.head, null);
    change(root);
    await readyToFinish(root);
    await assert.rejects(finish(root), error => error.code === 'INTEGRITY_REVIEW_REQUIRED');
    const checks = status(root).integrity;
    assert.equal(checks.testsAvailable, true);
    assert.equal(checks.reviewRequired, true);
    await recordReview(root, 'independent-reviewer', 'approve', 'Reviewed the change against the specification.');
    assert.equal((await finish(root)).phase, 'done');
  }
});

test('without a base commit, new tests and source edits finish without review', async t => {
  const root = await fixture(t);
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests/app.test.mjs'), 'assert(answer === 42);\n');
  await startTask(root, request);
  fs.writeFileSync(path.join(root, 'tests/new.test.mjs'), 'assert(true);\n');
  fs.writeFileSync(path.join(root, 'src/app.mjs'), 'export const answer = 42; // same value\n');
  await readyToFinish(root);
  const done = await finish(root);
  assert.equal(done.integrity.testsAvailable, true);
  assert.equal(done.integrity.reviewRequired, false);
});

test('without a base commit, an oversized or damaged manifest reports tests as unavailable and requires review', async t => {
  const root = await fixture(t);
  fs.mkdirSync(path.join(root, 'tests'));
  for (let index = 0; index <= 5000; index++) fs.writeFileSync(path.join(root, `tests/case${index}.test.mjs`), '');
  await startTask(root, request);
  assert.match(readJson(root, '.leanloop/task.json').base.manifest.unavailable, /5000/);
  await readyToFinish(root);
  const checks = status(root).integrity;
  assert.equal(checks.testsAvailable, false);
  assert.equal(checks.reviewRequired, true);
  await assert.rejects(finish(root), error => error.code === 'INTEGRITY_REVIEW_REQUIRED' && /unavailable/.test(error.message));

  const damaged = await fixture(t);
  const started = await startTask(damaged, request);
  fs.writeFileSync(path.join(damaged, `.leanloop/manifests/${started.id}.json`), '{"version":1,"entries":[["x",null,null]]}');
  assert.match(status(damaged).integrity.reason, /does not match/);
  await readyToFinish(damaged);
  await assert.rejects(finish(damaged), error => error.code === 'INTEGRITY_REVIEW_REQUIRED');

  // A no-commit task started before manifests were recorded is also reported, not passed silently.
  const task = readJson(damaged, '.leanloop/task.json');
  delete task.base.manifest;
  atomicJson(damaged, '.leanloop/task.json', task);
  assert.match(status(damaged).integrity.reason, /predates/);
  assert.equal(status(damaged).integrity.reviewRequired, true);
});

test('changed check definitions require review; unrelated package.json and pyproject edits do not', async t => {
  const writeJson = (root, file, value) => fs.writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
  const pyproject = '[project]\nname = "app"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n';
  async function prepared(withCommit) {
    const root = await fixture(t);
    writeJson(root, 'package.json', { name: 'app', version: '1.0.0', scripts: { test: 'node --test' } });
    fs.writeFileSync(path.join(root, 'pyproject.toml'), pyproject);
    if (withCommit) commit(root);
    await startTask(root, request);
    return root;
  }
  for (const withCommit of [true, false]) {
    const harmless = await prepared(withCommit);
    writeJson(harmless, 'package.json', {
      name: 'app', version: '1.0.1', description: 'An app', dependencies: { lib: '^2.0.0' }, scripts: { test: 'node --test' },
    });
    fs.writeFileSync(path.join(harmless, 'pyproject.toml'),
      pyproject.replace('name = "app"', 'name = "app2"\ndependencies = ["lib>=2"]') + '\n[build-system]\nrequires = ["setuptools"]\n');
    await readyToFinish(harmless);
    const done = await finish(harmless);
    assert.deepEqual(done.integrity.checkDefinitionFiles, [], `with commit: ${withCommit}`);

    const appendPyproject = extra => root => fs.writeFileSync(path.join(root, 'pyproject.toml'), pyproject + extra);
    for (const [file, change] of [
      ['package.json', root => writeJson(root, 'package.json', { name: 'app', version: '1.0.0', scripts: { test: 'node -e 0' } })],
      // Runner configuration outside "scripts" changes what runs too.
      ['package.json', root => writeJson(root, 'package.json', {
        name: 'app', version: '1.0.0', scripts: { test: 'node --test' }, jest: { passWithNoTests: true, testPathIgnorePatterns: ['.'] },
      })],
      ['pyproject.toml', root => fs.writeFileSync(path.join(root, 'pyproject.toml'), pyproject.replace('-q', '-q -k nothing'))],
      // Dotted keys under [tool], spaced headers, and top-level dotted keys configure pytest as well.
      ['pyproject.toml', appendPyproject('\n[tool]\npytest.ini_options.python_files = ["nothing_*.py"]\n')],
      ['pyproject.toml', appendPyproject('\n[ tool . pytest . ini_options ]\npython_files = ["nothing_*.py"]\n')],
      ['pyproject.toml', root => fs.writeFileSync(path.join(root, 'pyproject.toml'),
        `tool.pytest.ini_options.python_files = ["nothing_*.py"]\n${pyproject}`)],
      // A multiline string could hide a header, so the whole file counts.
      ['pyproject.toml', root => fs.writeFileSync(path.join(root, 'pyproject.toml'),
        pyproject.replace('name = "app"', 'name = "app"\ndescription = """\n[tool.pytest.ini_options]\n"""'))],
      ['Makefile', root => fs.writeFileSync(path.join(root, 'Makefile'), 'test:\n\ttrue\n')],
      ['src/deep/conftest.py', root => {
        fs.mkdirSync(path.join(root, 'src/deep'));
        fs.writeFileSync(path.join(root, 'src/deep/conftest.py'), 'collect_ignore_glob = ["*"]\n');
      }],
      // pytest and jest find differently cased names on case-insensitive filesystems.
      ['src/Conftest.py', root => fs.writeFileSync(path.join(root, 'src/Conftest.py'), 'collect_ignore_glob = ["*"]\n')],
      ['JEST.CONFIG.JS', root => fs.writeFileSync(path.join(root, 'JEST.CONFIG.JS'), 'module.exports = { testMatch: [] };\n')],
      ['vitest.config.ts', root => fs.writeFileSync(path.join(root, 'vitest.config.ts'), 'export default {};\n')],
      ['.npmrc', root => fs.writeFileSync(path.join(root, '.npmrc'), 'script-shell=true\n')],
    ]) {
      const root = await prepared(withCommit);
      change(root);
      await readyToFinish(root);
      await assert.rejects(finish(root), error => error.code === 'INTEGRITY_REVIEW_REQUIRED' &&
        /check definitions changed/.test(error.message) && error.message.includes(file));
      assert.ok(status(root).integrity.checkDefinitionFiles.some(item => item.path === file), `${file}, with commit: ${withCommit}`);
    }
  }
});

test('a script file a configured check names is a check definition', async t => {
  for (const withCommit of [true, false]) {
    const root = await fixture(t, [{ name: 'unit', command: [process.execPath, 'ci/check.mjs', '--reporter=spec'] }]);
    fs.mkdirSync(path.join(root, 'ci'));
    fs.writeFileSync(path.join(root, 'ci/check.mjs'), "console.log('checked');\n");
    if (withCommit) commit(root);
    await startTask(root, { ...request, scope: ['src'] });
    fs.writeFileSync(path.join(root, 'ci/check.mjs'), 'process.exit(0);\n');
    await readyToFinish(root);
    const reported = status(root).integrity;
    assert.deepEqual(reported.checkDefinitionFiles, [{ status: 'M', path: 'ci/check.mjs' }], `with commit: ${withCommit}`);
    await assert.rejects(finish(root), error => error.code === 'INTEGRITY_REVIEW_REQUIRED' && error.message.includes('ci/check.mjs'));
  }
});

test('Git-ignored check definitions change the fingerprint and require review', async t => {
  for (const withCommit of [true, false]) {
    const root = await fixture(t);
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\nlocal/\n');
    fs.mkdirSync(path.join(root, 'local'));
    fs.writeFileSync(path.join(root, 'local/conftest.py'), '# kept as it was\n');
    fs.mkdirSync(path.join(root, 'node_modules/runner'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/runner/package.json'), '{"scripts":{"test":"a"}}\n');
    if (withCommit) commit(root);
    await startTask(root, { ...request, scope: ['src'] });
    // Installed dependencies are outside the scan, so reinstalling them changes nothing LeanLoop tracks.
    const start = fingerprint(root);
    fs.writeFileSync(path.join(root, 'node_modules/runner/package.json'), '{"scripts":{"test":"b"}}\n');
    assert.equal(fingerprint(root), start);
    fs.appendFileSync(path.join(root, '.git/info/exclude'), '.npmrc\n');
    fs.writeFileSync(path.join(root, '.npmrc'), 'script-shell=true\n');
    assert.notEqual(fingerprint(root), start, `with commit: ${withCommit}`);
    const run = await verify(root);
    assert.equal(run.attemptCharged, true);
    await recordProof(root, 1, 'Fixture check passed.');
    assert.deepEqual(status(root).integrity.checkDefinitionFiles, [{ status: 'A', path: '.npmrc' }]);
    await assert.rejects(finish(root), error => error.code === 'INTEGRITY_REVIEW_REQUIRED' && error.message.includes('A .npmrc'));

    fs.rmSync(path.join(root, '.npmrc'));
    fs.writeFileSync(path.join(root, 'local/conftest.py'), 'collect_ignore_glob = ["*"]\n');
    await readyToFinish(root);
    assert.deepEqual(status(root).integrity.checkDefinitionFiles, [{ status: 'M', path: 'local/conftest.py' }]);
    await assert.rejects(finish(root), error => error.code === 'INTEGRITY_REVIEW_REQUIRED');
    fs.writeFileSync(path.join(root, 'local/conftest.py'), '# kept as it was\n');
    await readyToFinish(root);
    assert.equal((await finish(root)).phase, 'done');
  }
});

test('changes that predate the task are not charged to it; later edits to those files are', async t => {
  const writeJson = (root, file, value) => fs.writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
  const prepared = async () => {
    const root = await committed(t);
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs/guide.md'), 'Guide.\n');
    fs.writeFileSync(path.join(root, 'docs/old.md'), 'Old.\n');
    writeJson(root, 'package.json', { name: 'app', scripts: { test: 'node --test' } });
    commit(root);
    // The user's own uncommitted work, present before the task starts.
    fs.appendFileSync(path.join(root, 'docs/guide.md'), 'A local note.\n');
    fs.rmSync(path.join(root, 'docs/old.md'));
    fs.writeFileSync(path.join(root, 'notes.md'), 'Untracked notes.\n');
    fs.appendFileSync(path.join(root, 'tests/app.test.mjs'), '// user edit\n');
    writeJson(root, 'package.json', { name: 'app', scripts: { test: 'node --test --test-reporter=spec' } });
    await startTask(root, { ...request, scope: ['src'] });
    fs.writeFileSync(path.join(root, 'src/app.mjs'), 'export const answer = 42; // in scope\n');
    return root;
  };
  const untouched = await prepared();
  await readyToFinish(untouched);
  const done = await finish(untouched);
  assert.equal(done.phase, 'done');
  assert.equal(done.integrity.reviewRequired, false);

  const edited = await prepared();
  fs.appendFileSync(path.join(edited, 'docs/guide.md'), 'The task edited this too.\n');
  fs.appendFileSync(path.join(edited, 'tests/app.test.mjs'), 'weakened();\n');
  writeJson(edited, 'package.json', { name: 'app', scripts: { test: 'node -e 0' } });
  // Restoring a file to HEAD is still a change made by the task.
  fs.writeFileSync(path.join(edited, 'docs/old.md'), 'Old.\n');
  await readyToFinish(edited);
  const reported = status(edited).integrity;
  assert.deepEqual(reported.outOfScope.map(item => `${item.status} ${item.path}`).sort(),
    ['A docs/old.md', 'M docs/guide.md', 'M package.json', 'M tests/app.test.mjs']);
  assert.deepEqual(reported.testFiles, [{ status: 'M', path: 'tests/app.test.mjs' }]);
  assert.deepEqual(reported.checkDefinitionFiles, [{ status: 'M', path: 'package.json' }]);
  await assert.rejects(finish(edited), error => error.code === 'INTEGRITY_REVIEW_REQUIRED');
});

test('files changed outside the task scope are listed and require review', async t => {
  for (const withCommit of [true, false]) {
    const root = await fixture(t);
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs/guide.md'), 'Guide.\n');
    if (withCommit) commit(root);
    await startTask(root, { ...request, scope: ['src'] });
    fs.writeFileSync(path.join(root, 'src/app.mjs'), 'export const answer = 42; // in scope\n');
    fs.writeFileSync(path.join(root, 'src/extra.mjs'), 'export {};\n');
    assert.deepEqual(status(root).integrity.outOfScope, []);
    fs.writeFileSync(path.join(root, 'docs/guide.md'), 'Rewritten guide.\n');
    fs.writeFileSync(path.join(root, 'notes.md'), 'New file outside scope.\n');
    await readyToFinish(root);
    const reported = status(root).integrity;
    assert.deepEqual(reported.outOfScope.map(item => item.path).sort(), ['docs/guide.md', 'notes.md'], `with commit: ${withCommit}`);
    assert.equal(reported.reviewRequired, true);
    await assert.rejects(finish(root), error => error.code === 'SCOPE_REVIEW_REQUIRED' && error.message.includes('notes.md'));
    await recordReview(root, 'independent-reviewer', 'approve', 'The out-of-scope edits were requested.');
    const done = await finish(root);
    assert.equal(done.phase, 'done');
    assert.equal(done.integrity.outOfScopeCount, 2);
  }
});

test('an unscoped task reports no out-of-scope files', async t => {
  const root = await committed(t);
  await startTask(root, request);
  fs.writeFileSync(path.join(root, 'notes.md'), 'Anywhere is in scope.\n');
  await readyToFinish(root);
  const done = await finish(root);
  assert.deepEqual(done.integrity.outOfScope, []);
  assert.equal(done.integrity.reviewRequired, false);
});

test('failed checks carry an output excerpt; passing checks and checkpoints record what ran', async t => {
  const script = "const ok = require('fs').readFileSync('src/app.mjs', 'utf8').includes('42');" +
    "if (!ok) console.error('expected 42 in src/app.mjs'); process.exit(ok ? 0 : 1);";
  const root = await fixture(t, [{ name: 'unit', command: [process.execPath, '-e', script] }]);
  fs.writeFileSync(path.join(root, 'src/app.mjs'), 'export const answer = 41;\n');
  await startTask(root, request);
  const red = await verify(root);
  assert.equal(red.ok, false);
  assert.match(red.results[0].excerpt, /expected 42/);
  assert.match(red.results[0].excerptNote, /untrusted/);
  await checkpoint(root, 'Reproduced the wrong answer.', 'Restore 42.');
  assert.deepEqual(status(root).next.lastCheck, { fresh: true, passed: [], failed: ['unit'] });
  fs.writeFileSync(path.join(root, 'src/app.mjs'), 'export const answer = 42;\n');
  const green = await verify(root);
  assert.equal(green.ok, true);
  assert.equal(Object.hasOwn(green.results[0], 'excerpt'), false);
  assert.deepEqual(status(root).observedFailToPass, ['unit']);
});

test('a finished step keeps its last checkpoint in status, so a multi-step plan survives a cleared context', async t => {
  const root = await fixture(t);
  await startTask(root, { goal: 'Step 1: api', criteria: ['api check passes'], scope: ['src'] });
  assert.equal((await verify(root)).ok, true);
  await recordProof(root, 1, 'api check passed on the final source.');
  await checkpoint(root, 'api migrated to the new field.', 'Start step 2: migrate billing, then step 3: report.');
  assert.equal((await finish(root)).phase, 'done');
  const resumed = status(root);
  assert.equal(resumed.phase, 'done');
  assert.match(resumed.next.next, /step 2: migrate billing/);
  await startTask(root, { goal: 'Step 2: billing', criteria: ['billing check passes'] });
  assert.equal(status(root).next, null);
});
