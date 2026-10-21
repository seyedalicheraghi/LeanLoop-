#!/usr/bin/env bash
# Fixture: parseDuration counts minutes as 100 seconds, so 1h30m gives 6600 instead of 5400.
set -euo pipefail
mkdir -p src test
cat > src/duration.mjs <<'EOF'
// Returns the duration in seconds.
export function parseDuration(text) {
  const units = { h: 3600, m: 100, s: 1 };
  let total = 0;
  for (const [, value, unit] of text.matchAll(/(\d+)([hms])/g)) total += Number(value) * units[unit];
  return total;
}
EOF
cat > test/duration.test.mjs <<'EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../src/duration.mjs';

test('seconds', () => assert.equal(parseDuration('45s'), 45));
EOF
cat > leanloop.json <<'EOF'
{
  "version": 1,
  "attemptLimit": 3,
  "checks": [{ "name": "unit", "command": ["node", "--test", "test/duration.test.mjs"] }]
}
EOF
mkdir -p .leanloop && printf '*\n' > .leanloop/.gitignore
git init -q
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture
