import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execute } from '../lib/cli.mjs';
import { LESSONS_FILE, MAX_LESSONS } from '../lib/lessons.mjs';
import { fixture, temporary, cli, commit, git } from './helpers.mjs';

const run = (root, args) => execute([args[0], '--project', root, ...args.slice(1)]);

test('lessons are added, replaced, listed, and forgotten in a readable file', async t => {
  const root = await fixture(t);
  const first = await run(root, ['learn', 'Run one test file with node --test FILE.', '--evidence', 'Full suite takes 4 min; one file 2 s.']);
  assert.equal(first.lesson.id, 1);
  await run(root, ['learn', 'Fixtures live in tests/fixtures.', '--evidence', 'ls tests/fixtures']);
  const replaced = await run(root, ['learn', 'Fixtures live in test/data.', '--evidence', 'Moved in the last refactor.', '--replace', '2']);
  assert.equal(replaced.lesson.id, 2);
  const listed = await run(root, ['lessons']);
  assert.deepEqual(listed.lessons.map(item => item.text), ['Run one test file with node --test FILE.', 'Fixtures live in test/data.']);
  const file = fs.readFileSync(path.join(root, LESSONS_FILE), 'utf8');
  assert.match(file, /^# Project lessons/);
  assert.match(file, /- L2 \(\d{4}-\d{2}-\d{2}\) Fixtures live in test\/data\. \[evidence: Moved in the last refactor\.\]/);
  const forgotten = await run(root, ['forget', '1']);
  assert.equal(forgotten.count, 1);
  assert.deepEqual((await run(root, ['lessons'])).lessons.map(item => item.id), [2]);
});

test('lesson memory is capped by count and bytes and refuses to grow', async t => {
  const root = await fixture(t);
  for (let index = 1; index <= MAX_LESSONS; index += 1) {
    await run(root, ['learn', `Lesson number ${index} is short.`, '--evidence', `check ${index}`]);
  }
  const before = fs.readFileSync(path.join(root, LESSONS_FILE), 'utf8');
  await assert.rejects(run(root, ['learn', 'One more lesson.', '--evidence', 'x']), error => error.code === 'LESSONS_FULL');
  assert.equal(fs.readFileSync(path.join(root, LESSONS_FILE), 'utf8'), before);

  const other = await fixture(t);
  await assert.rejects(async () => {
    for (let index = 1; index <= MAX_LESSONS; index += 1) {
      await run(other, ['learn', `${index} ${'long detail '.repeat(24)}`.slice(0, 300), '--evidence', 'e'.repeat(180)]);
    }
  }, error => error.code === 'LESSONS_FULL');
  assert.ok(fs.statSync(path.join(other, LESSONS_FILE)).size <= 8 * 1024);
});

test('lessons must be single-line, evidence-backed, and never drop hand-written text', async t => {
  const root = await fixture(t);
  await assert.rejects(run(root, ['learn', 'Two\nlines', '--evidence', 'x']), /one line/);
  await assert.rejects(run(root, ['learn', 'No evidence']), /Evidence must be nonempty/);
  await assert.rejects(run(root, ['learn', 'Fake [evidence: x]', '--evidence', 'y']), /one line/);
  fs.writeFileSync(path.join(root, LESSONS_FILE), '# Project lessons\n\nA personal note that is not an entry.\n');
  await assert.rejects(run(root, ['learn', 'New lesson.', '--evidence', 'x']), /line 3 differs from the managed header/);
  assert.match(fs.readFileSync(path.join(root, LESSONS_FILE), 'utf8'), /personal note/);
  fs.rmSync(path.join(root, LESSONS_FILE));
  await run(root, ['learn', 'First lesson.', '--evidence', 'x']);
  fs.appendFileSync(path.join(root, LESSONS_FILE), '# Project lessons\n');
  const merged = fs.readFileSync(path.join(root, LESSONS_FILE), 'utf8');
  await assert.rejects(run(root, ['forget', '1']), /line 7 is not a lesson entry/);
  assert.equal(fs.readFileSync(path.join(root, LESSONS_FILE), 'utf8'), merged);
  const missing = temporary(t);
  assert.notEqual(cli(missing, ['learn', 'x', '--evidence', 'y']).status, 0);
});

test('recording a lesson does not invalidate fresh verification evidence', async t => {
  const root = await fixture(t);
  commit(root);
  await run(root, ['start', 'Small change', '--accept', 'The fixture passes']);
  assert.equal((await run(root, ['check'])).ok, true);
  await run(root, ['prove', '1', 'fixture check passed']);
  await run(root, ['learn', 'The fixture check prints a marker.', '--evidence', 'check output']);
  git(root, ['add', LESSONS_FILE]);
  await run(root, ['learn', 'Read the small fixture first.', '--evidence', 'src/app.mjs']);
  const finished = await run(root, ['finish']);
  assert.equal(finished.phase, 'done');
});

test('manually expanded lesson files cannot bypass the read budgets', async t => {
  const root = await fixture(t);
  await run(root, ['learn', 'First lesson.', '--evidence', 'check']);
  const file = path.join(root, LESSONS_FILE);
  const original = fs.readFileSync(file, 'utf8');
  const extra = Array.from({ length: 30 }, (_, i) => `- L${i + 2} (2026-01-01) Lesson ${i}. [evidence: check]\n`).join('');
  for (const content of [original + extra, original + '\n'.repeat(8192)]) {
    fs.writeFileSync(file, content);
    const result = cli(root, ['lessons']);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr).code, 'LESSONS_FULL');
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
});
