#!/usr/bin/env bash
# Fixture: createUser accepts blank names and invalid ages; the existing tests describe the required validation.
set -euo pipefail
mkdir -p src test
cat > src/users.mjs <<'EOF'
export function createUser(name, age) {
  return { name: name.trim(), age };
}
EOF
cat > test/users.test.mjs <<'EOF'
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUser } from '../src/users.mjs';

test('creates a user', () => assert.deepEqual(createUser(' Ada ', 36), { name: 'Ada', age: 36 }));
test('rejects a blank name', () => assert.throws(() => createUser('  ', 36), /name/));
test('rejects a negative age', () => assert.throws(() => createUser('Ada', -1), /age/));
test('rejects a fractional age', () => assert.throws(() => createUser('Ada', 1.5), /age/));
EOF
cat > leanloop.json <<'EOF'
{
  "version": 1,
  "attemptLimit": 3,
  "checks": [{ "name": "unit", "command": ["node", "--test", "test/users.test.mjs"] }]
}
EOF
mkdir -p .leanloop && printf '*\n' > .leanloop/.gitignore
git init -q
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture
