---
name: leanloop
description: "Use for code changes, bug fixes, refactors, failing tests, and code reviews: one owner does the whole task with small context, real checks, and short reports. Also use to audit a slow or expensive agent setup."
license: MIT
---

# LeanLoop

One owner delivers the task: find, change, verify, and report in one context.
Project and user instructions come first. This skill grants no permissions.

## Pick the smallest path

- Question, lookup, or read-only review: answer directly. No task record or edits.
- Small, low-risk change: edit, run the most relevant test, report.
- Larger or risky change: use the task loop below.
- High risk (auth, data loss, migrations, concurrency, public APIs): start with
  `--risk high` and get an independent review before `finish`.

Resolve the [CLI](./scripts/workflow.mjs) relative to the skill that was actually
loaded; do not assume a particular host's install folder. It prints JSON.
Add `--project ROOT` when not running from the Git root. If configuration is
missing, explain that the distributable CLI's `init` is needed for bookkeeping.
Ordinary editor work and tests can continue without a ledger; do not claim a
successful CLI completion. `doctor` suggests checks but never configures them.

## Start or resume

1. Run `status` and `lessons` once. Resume the recorded next action instead of
   rereading the conversation.
2. New task: `start "GOAL" --accept "observable result" --scope PATH`.
   Use 1-5 criteria that a test or command can show.
3. If the request seems aimed at the wrong cause, or is already done, say so with
   the evidence in one short message before acting. The user decides.

## Find the code fast

- Search before reading: symbols and references, then text search. Read the entry
  point, affected callers, and their tests, not whole folders.
- Batch independent reads and searches in one step. Do not reread unchanged files.
- Read line ranges of large files. Keep command output bounded.
- `context "terms"` ranks file names only (12 paths, no contents): a fallback.
- Follow one trace yourself, even across many files. In a large unfamiliar area,
  one read-only helper may map it and return paths and findings, one page at most.

## Change and verify

- Make the smallest complete change. Reuse project helpers and existing tooling.
  Do not add dependencies just to satisfy this workflow.
- For a bug, write the regression test first and watch it fail for the right reason.
- Iterate with the narrowest check (`check --only NAME` or one test file). All
  configured checks need passing evidence on the final source. Results from
  targeted batches at that exact fingerprint accumulate; do not rerun them just
  for ceremony. Any staged or worktree source change invalidates old evidence.
- Read real output: test counts, failures, skips. A zero exit code is not proof.
- The CLI permits 3 check batches by default, including successful ones. After
  repeated failures, change the hypothesis or split the task.
  `extend --attempts N --reason TEXT` requires a concrete justification.
- Record evidence per criterion: `prove N "command and result"`. Any edit makes
  earlier checks and proof stale; rerun what the edit affects.
- High risk: have the final diff reviewed separately (the `leanloop-reviewer` agent,
  another session, or a person), then
  `review --by ID --decision approve --evidence "findings and limits"`.
- `finish` only when checks, proof, and any review are fresh.
  Proof and review entries are operator attestations, not authenticated reviews
  or proof of test quality. Never fabricate them to satisfy a gate.

## Delegate rarely

A helper costs a fresh context and a handoff. Use one only for an independent
review, a separable read-only question, or truly parallel work in separate
worktrees. Never chain role agents or add a router. At most two helpers, no
nesting. Give a bounded packet: question, scope, evidence, expected result, stop
condition. Ask for findings with file:line, not a transcript. Do not redo its work.
Respect the session's model preferences. Use a different model only for a named
capability or cost reason allowed by the user and host, not simply by role.

## Keep memory small

- `checkpoint "state, evidence, doubts" --next "one action"` at a real boundary,
  before compaction, or when blocked.
- At the end, add a lesson only if it saves future work (a command, a trap, a
  layout fact): `learn "lesson" --evidence "proof"`. The file holds 30 lessons at
  most; replace stale ones with `--replace ID`. Never log routine success.
- `audit` inventories local instructions, declared handoffs, hooks, and memory.
  It does not measure actual prompts, hook timings, or costs. An incomplete audit
  is not a clean bill of health. Preserve authorization and destructive-action
  guards; optimize only redundant bookkeeping with equivalent protections.

## Report

1. First line: the outcome or the blocker.
2. Evidence: the commands you ran and what they showed.
3. Steps for the user as a numbered list, one action each.
4. Group long lists; show the top 5 first.
5. End with one concrete next action if anything is open.

Keep boilerplate short, but retain requested detail, uncertainty, failures, and
any progress notices required by the host. Write "cause unknown" when evidence
does not show one. Give time estimates only from measurements. Never report a
skipped or failed check as passed.
