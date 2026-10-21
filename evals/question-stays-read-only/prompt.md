---
description: A read-only question about suspicious code; the agent should answer with evidence and make no edits.
tags: [read-only]
runs: 3
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill]
---
What does parseDuration('1h30m') in src/duration.mjs return? I suspect it is wrong.
