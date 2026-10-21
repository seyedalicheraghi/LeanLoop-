#!/usr/bin/env node
import fs from 'node:fs';
import { parseRuns, compareRuns } from '../lib/metrics.mjs';

try {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/compare-runs.mjs BASELINE.jsonl CANDIDATE.jsonl');
  const inputs = process.argv.slice(2).map(file => {
    if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('Measurements exceed 2 MiB.');
    return parseRuns(fs.readFileSync(file, 'utf8'));
  });
  const report = compareRuns(...inputs);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.observedGate === 'pass' ? 0 : 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 2;
}
