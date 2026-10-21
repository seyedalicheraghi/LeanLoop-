---
description: Three packages with their own checks each have a bug; the agent should fix them one at a time in one task, checkpoint between them, and report each check.
tags: [multi-component]
runs: 3
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill]
---
After last week's refactor, the api, billing, and report packages each have a failing test. Fix all three. Each package has its own check in leanloop.json.
