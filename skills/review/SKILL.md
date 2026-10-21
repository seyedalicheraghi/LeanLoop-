---
name: review
description: "Run LeanLoop's thorough code reviewer on a change: uncommitted work, a commit range, a branch, or paths. Reports only verified findings."
argument-hint: "[target]"
disable-model-invocation: true
license: MIT
---

# LeanLoop review

Launch the `leanloop:code-reviewer` agent on the target the user names; by
default, uncommitted changes, else the branch against its merge-base. Pass the
target, the intent if known, and whether it may run the project's tests (only
if the user said so). Relay its report as written: do not soften, extend, or
fix anything unless asked.

If a LeanLoop task is active (`node "${CLAUDE_PLUGIN_ROOT}/leanloop.mjs" status`),
offer to record the verdict: `node "${CLAUDE_PLUGIN_ROOT}/leanloop.mjs" review
--by code-reviewer --decision approve|request-changes --evidence "summary"`. The
record is an attestation and must match the agent's actual verdict.
