---
name: setup
description: "Prepare this project for LeanLoop: create leanloop.json and ignored .leanloop/ state, then choose real checks with the user."
disable-model-invocation: true
license: MIT
---

# LeanLoop setup

CLI: `node "${CLAUDE_PLUGIN_ROOT}/leanloop.mjs" COMMAND`, run from the project's
Git root.

1. Run `init --dry-run`, show what it would create, then run `init`. It only
   creates `leanloop.json` and `.leanloop/.gitignore` and never overwrites. Pass
   on any `warning`, such as copies left by LeanLoop 0.4.0.
2. Run `doctor`. It suggests checks from the project's own scripts and never
   records them.
3. Before proposing a command, read what it executes (package.json scripts,
   Makefile targets, test config). Prefer one fast unit check and one broader
   regression check. In a monorepo, target the affected package, never
   everything by default.
4. Ask the user which checks to record. For each approved one, run the command
   once yourself on the unchanged project and confirm it passes, then record it:
   `add-check NAME --timeout SECONDS -- EXECUTABLE ARGS...` (an argument list,
   not a shell string). On Windows, `npm`-style `.cmd` tools cannot take
   arguments containing `"`, `%`, or `!`.
5. If tests live outside common folders (`test/`, `tests/`, `__tests__/`,
   `spec/`, `*.test.*`, `*_test.*`), add their globs to `testPaths` in
   `leanloop.json` so edits to them need review.
6. Report the files created, the checks recorded, and anything skipped. Do not
   change CLAUDE.md, settings, or permissions.
