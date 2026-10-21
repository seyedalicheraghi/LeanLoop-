#!/usr/bin/env bash
# Fixture: three packages each have one bug, and each package has its own check.
set -euo pipefail
mkdir -p src test
mkdir -p packages/api/src packages/api/test packages/billing/src packages/billing/test packages/report/src packages/report/test
cat > packages/api/src/orders.mjs <<'EOF'
export function orderTotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}
EOF
cat > packages/api/test/orders.test.mjs <<'EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderTotal } from '../src/orders.mjs';

test('multiplies price by quantity', () => assert.equal(orderTotal([{ price: 2, quantity: 3 }, { price: 5, quantity: 1 }]), 11));
EOF
cat > packages/billing/src/tax.mjs <<'EOF'
export function addTax(amount, rate) {
  return amount + rate;
}
EOF
cat > packages/billing/test/tax.test.mjs <<'EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
import { addTax } from '../src/tax.mjs';

test('applies a percentage rate', () => assert.equal(addTax(100, 0.2), 120));
EOF
cat > packages/report/src/money.mjs <<'EOF'
export function formatMoney(cents) {
  return '$' + cents / 100;
}
EOF
cat > packages/report/test/money.test.mjs <<'EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney } from '../src/money.mjs';

test('always shows two decimals', () => assert.equal(formatMoney(1050), '$10.50'));
EOF
cat > leanloop.json <<'EOF'
{
  "version": 1,
  "attemptLimit": 3,
  "checks": [{ "name": "api", "command": ["node", "--test", "packages/api/test/orders.test.mjs"] },
    { "name": "billing", "command": ["node", "--test", "packages/billing/test/tax.test.mjs"] },
    { "name": "report", "command": ["node", "--test", "packages/report/test/money.test.mjs"] }]
}
EOF
mkdir -p .leanloop && printf '*\n' > .leanloop/.gitignore
git init -q
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture
