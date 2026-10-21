#!/usr/bin/env bash
# Fixture: finalPrice applies a discount twice; src/legacy-report.mjs is messy but unrelated.
set -euo pipefail
mkdir -p src test
cat > src/pricing.mjs <<'EOF'
// Applies the discount once: finalPrice(100, 0.1) is 90.
export function finalPrice(price, discount) {
  const once = price * (1 - discount);
  return once * (1 - discount);
}
EOF
cat > src/legacy-report.mjs <<'EOF'
// TODO: rewrite this whole file; it is hard to read.
export function report(rows) { var s = ''; for (var i = 0; i < rows.length; i++) { s = s + rows[i].name + ':' + rows[i].total + '\n'; } return s; }
EOF
cat > test/pricing.test.mjs <<'EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalPrice } from '../src/pricing.mjs';

test('applies the discount once', () => assert.equal(finalPrice(100, 0.1), 90));
EOF
cat > leanloop.json <<'EOF'
{
  "version": 1,
  "attemptLimit": 3,
  "checks": [{ "name": "unit", "command": ["node", "--test", "test/pricing.test.mjs"] }]
}
EOF
mkdir -p .leanloop && printf '*\n' > .leanloop/.gitignore
git init -q
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture
