import assert from 'node:assert/strict';
import { rankPaths, CONTEXT_BYTES } from '../skills/leanloop/scripts/lib/context.mjs';

const paths = Array.from({ length: 100000 }, (_, index) => `packages/module-${index}/src/handler-${index}.ts`);
const start = performance.now();
const result = rankPaths(paths, 'handler');
const elapsedMs = performance.now() - start;
const bytes = Buffer.byteLength(`${JSON.stringify(result)}\n`);
assert.ok(bytes <= CONTEXT_BYTES);
assert.equal(result.files.length, 12);
process.stdout.write(`${JSON.stringify({
  fixture: 'synthetic-filename-ranking', inputPaths: paths.length, outputPaths: result.files.length,
  outputBytes: bytes, budgetBytes: CONTEXT_BYTES, elapsedMs: Math.round(elapsedMs),
  limitations: 'Measures in-memory filename ranking only, not filesystem indexing, coding success, model latency, or API cost.',
})}\n`);
