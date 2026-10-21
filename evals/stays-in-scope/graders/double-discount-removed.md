---
type: regex
target: { source: file, path: src/pricing.mjs }
pattern: 'once \* \(1 - discount\)'
match: "not_contains"
---
