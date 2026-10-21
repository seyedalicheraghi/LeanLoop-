# Adoption without stacking workflows

## Pilot first

Use a disposable branch/worktree of a non-sensitive project. Do not globally
replace an existing workflow on the first run.

1. Record a baseline on representative tasks using the existing workflow, and save
   the output of `audit --project PATH` as the starting measurement.
2. Inventory active project/user instructions, agent definitions, skills, hooks,
   and model overrides in the host's customization UI.
3. Deliberately remove or narrow obsolete mandatory routing rules in the pilot.
   Keep project conventions, safety controls, and required validation.
4. Install this kit with `init --dry-run`, inspect the planned files, then `init`.
5. Configure real checks and verify discovery in a new session.

The installer intentionally does not perform step 3 for you. It cannot know which
existing restrictions are team policy, safety controls, or personal experiments.

## Replace coordination overhead, not useful safeguards

| Existing pattern | Candidate replacement |
|---|---|
| A planner, writer, tester, and reporter for every patch | One owner changes phases within the same context |
| Mandatory review after each intermediate edit | Relevant checks during iteration; independent review of the final risky change |
| Repeated whole-repository reads | Symbol/reference lookup, then bounded candidate paths and selective reads |
| All agents append general learning every turn | A milestone checkpoint with evidence, uncertainty, and one next action |
| Model chosen permanently by job title | Current model by default; explicit escalation for a capability gap |
| Every tool call goes through a dispatch ledger | Record a task boundary, meaningful checkpoint, and final evidence |
| A router agent that only dispatches specialists | The owner does the work; no router |
| One learnings file per agent, read in full at every start | One shared lessons file, at most 30 entries and 8 KiB |
| Redundant per-tool bookkeeping | Measure, then narrow or combine it while preserving safety enforcement |
| Monitors used only to coordinate role handoffs | One owner and `status`; retain operational health monitoring where needed |
| Long always-on rule files | Always-on text limited to commands, layout, and hard rules; procedures in skills |

Do not remove an approval boundary for destructive or externally consequential
actions merely to save time. The host still controls tool permissions.

## Converting a role-per-agent suite, step by step

1. **Measure.** Run `audit` on the suite and keep the JSON. Note always-on bytes,
   agent count, longest handoff chain, per-tool hook commands, and memory bytes.
2. **Keep the knowledge, drop the roles.** For each specialist agent, move durable
   domain knowledge (how the pipeline works, where data lives, known defects) into
   one on-demand skill or a short project guide. Remove unnecessary handoff
   ceremony, not ownership boundaries or approval gates that protect real resources.
3. **Collapse memory.** Read the per-agent learnings and ledgers once. Keep at most
   30 lessons that are still true and save real time; record each with
   `learn "..." --evidence "..."`. Archive the rest outside the agents' reading path.
4. **Replace checks done by agents with commands.** A "tester" or "forensics" agent
   becomes configured checks (`add-check`) and `--expect-output` markers that the
   CLI runs with timeouts and bounded logs.
5. **Keep one reviewer.** Use the read-only `leanloop-reviewer` for high-risk final
   diffs only, not after every intermediate edit.
6. **Measure hooks and daemons before changing them.** Keep authorization, secret
   protection, expensive-run limits, and destructive-action controls. Narrow or
   combine redundant bookkeeping only after proving equivalent protections.
7. **Shrink always-on text** to about 8 KiB or less: build/test commands, layout,
   hard safety rules. Everything procedural moves into skills.
8. **Compare.** Rerun `audit` and the same tasks; record time, provider-reported
   tokens or cost, and success with [the evaluation procedure](evaluation.md).
   Keep failures in the data.

Domain rules that encode real hazards (for example "never write to a shared data
mount" or "never launch expensive jobs without a budget check") stay. Enforce them
with a narrow hook or check, not with a role chain.

Audit byte counts and handoff paths are not token bills or timings. Verify actual
host loading and traces before claiming a speedup. Do not compare unpaired session
averages as if the tasks, models, and accepted outcomes were controlled.

## VS Code and other hosts

In VS Code's Copilot harness, skills in `.github/skills/`, `.agents/skills/`, and
`.claude/skills/` are discovered, and custom agents in `.github/agents/`. Codex
and Gemini CLI discover `.agents/skills/`; Claude Code discovers `.claude/skills/`
and `.claude/agents/`. That is why `portable` is the default host. Reusable
workflows are skills; ordinary `.prompt.md` files are a different feature, not
the primary adapter used here.

The copied skill contains its own Node runtime and relative references. Do not
assume identical tool aliases, agent discovery, or slash commands across clients.
The reviewer definition uses documented Copilot aliases; the `claude` host gets a
converted copy with Claude Code tool names.

Keep existing user-level rules in mind: project file installation does not disable
them. If the new session still launches a mandatory chain, inspect the active
instruction sources before adding another rule.

## Rollback and maintenance

1. Stop the current task or record a cancellation; do not leave checks running.
2. Restore the pilot's prior customization files from your own version control
   or backups, preserving unrelated work.
3. Remove only kit-managed paths after comparing their current contents.
4. Keep or securely dispose of ignored state/logs according to your requirements.

There is intentionally no broad uninstall command or force-overwrite option.
Generated state is separate from the project configuration and skill files.
For a new release, run the distributable CLI's `init --upgrade --dry-run` first.
The registry permits replacement/removal only of unmodified previously managed
files. `init --upgrade` applies that plan without changing check configuration.
Locally edited assets require explicit reconciliation; never discard them just
to make an upgrade succeed. Review the installed runtime when updating: it is a
copied version, not a hidden auto-updating symlink.

Version 0.3.0 fingerprints staged and worktree diffs separately. Existing task
evidence from older runtimes will be stale after upgrading; rerun checks and
record fresh proof/review rather than editing the stored hashes.

## Moving from lean-workflow

Version 0.4.0 renamed the project from lean-workflow to LeanLoop. Every installed
path changed, and `init` refuses a project that still has the old
`.lean-workflow/install.json` or `lean-workflow.json` rather than installing a
second copy beside it. There is no automatic migration: the old files may hold
local edits and task state that only you can judge.

| Before (0.3.0 and earlier) | After (0.4.0) |
|---|---|
| `.agents/skills/lean-workflow/` (or `.github/`, `.claude/`) | `.agents/skills/leanloop/` (same host folders) |
| `.github/agents/lean-reviewer.agent.md`, `.claude/agents/lean-reviewer.md` | `leanloop-reviewer.agent.md`, `leanloop-reviewer.md` |
| `lean-workflow.json` | `leanloop.json` |
| `lean-workflow.lessons.md` | `leanloop.lessons.md` |
| `.lean-workflow/` state and logs | `.leanloop/` |
| `/lean-workflow`, `lean-workflow` CLI | `/leanloop`, `leanloop` CLI |

1. Finish or cancel any active task with the old runtime.
2. Rename `lean-workflow.json` to `leanloop.json`. Its format is unchanged.
3. If you keep lessons, rename the file to `leanloop.lessons.md` and replace
   `lean-workflow` with `LeanLoop` in its third line; the header is validated.
4. Compare the old skill and reviewer files with the 0.3.0 release, then remove
   them yourself. Move any `.lean-workflow/` state you want to keep out of the
   project; `init` refuses while `.lean-workflow/install.json` exists.
5. Run `init --dry-run`, then `init`, with the hosts you used before.
