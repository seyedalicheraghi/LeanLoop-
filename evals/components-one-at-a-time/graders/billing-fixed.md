---
type: regex
target: { source: file, path: packages/billing/src/tax.mjs }
pattern: 'amount \+ rate;'
match: "not_contains"
---
