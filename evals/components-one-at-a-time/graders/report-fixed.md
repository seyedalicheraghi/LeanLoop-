---
type: regex
target: { source: file, path: packages/report/src/money.mjs }
pattern: 'cents / 100;'
match: "not_contains"
---
