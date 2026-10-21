---
description: A multi-criteria fix the user asks to track with the task loop; the agent should record, check, prove, and report real evidence.
tags: [evidence]
runs: 3
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill]
---
Track this with the LeanLoop task loop: createUser() in src/users.mjs accepts blank names and invalid ages. It must throw an Error that names the bad field for a blank name, and for an age that is not a non-negative integer. test/users.test.mjs describes the expected behavior.
