#!/usr/bin/env node
// Opt-in scale check: builds a synthetic Git repository with N tracked files and times the CLI loop.
// Usage: node scripts/benchmark-large-repo.mjs [FILES]   (default 150000)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { install } from '../lib/install.mjs';
import { execute } from '../skills/leanloop/scripts/lib/cli.mjs';

const count = Number(process.argv[2] ?? 150000);
if (!Number.isSafeInteger(count) || count < 1 || count > 2000000) throw new Error('FILES must be an integer from 1 to 2000000.');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leanloop-scale-')));
const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false', '-c', 'user.name=Scale Benchmark', '-c', 'user.email=benchmark@example.invalid', '-C', root, ...args],
{ stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 });
const timings = {};
async function time(label, action) {
  const started = performance.now();
  const result = await action();
  timings[label] = Math.round(performance.now() - started);
  return result;
}
const run = args => execute([args[0], '--project', root, ...args.slice(1)]);

try {
  await time('createFilesMs', () => {
    git(['init', '-q', '--initial-branch=main']);
    for (let index = 0; index < count; index += 1) {
      const directory = path.join(root, 'packages', `pkg-${Math.floor(index / 1000)}`, 'src');
      if (index % 1000 === 0) fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, `handler-${index}.ts`), `export const value${index} = ${index};\n`);
    }
  });
  await time('gitCommitMs', () => {
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'synthetic scale fixture\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>']);
  });
  await install(root);
  await run(['add-check', 'smoke', '--', process.execPath, '-e', 'console.log("smoke ok")']);
  await time('startMs', () => run(['start', 'Scale check', '--accept', 'The smoke check passes']));
  const statusResult = await time('statusMs', () => run(['status']));
  const checkResult = await time('checkMs', () => run(['check']));
  await time('proveMs', () => run(['prove', '1', 'smoke check passed in the synthetic repository']));
  const finishResult = await time('finishMs', () => run(['finish']));
  const expectedPath = `packages/pkg-${Math.floor((count - 1) / 1000)}/src/handler-${count - 1}.ts`;
  const contextResult = await time('contextMs', () => run(['context', `handler-${count - 1}`]));
  const auditResult = await time('auditMs', () => run(['audit']));
  const ok = statusResult.ok && checkResult.allChecksPassed && finishResult.phase === 'done' &&
    contextResult.files[0]?.path === expectedPath && auditResult.ok;
  process.stdout.write(`${JSON.stringify({
    fixture: 'synthetic-git-repository', trackedFiles: count, indexListingBytes: git(['ls-files', '--stage', '-v', '-z']).length,
    ok,
    timings, contextTop: contextResult.files[0]?.path ?? null,
    limitations: 'Synthetic tiny files on a local disk. Measures CLI bookkeeping latency only, not model speed, cost, or coding quality.',
  })}\n`);
  if (!ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, trackedFiles: count, timings, error: error.message })}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
