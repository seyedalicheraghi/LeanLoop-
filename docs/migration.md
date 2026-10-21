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
4. Install the plugin, run `/leanloop:setup`, and inspect what `init --dry-run` plans.
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
   agent count, router agents, per-tool hook commands, and memory bytes.
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

Audit byte counts and agent inventories are not token bills or timings. Verify actual
host loading and traces before claiming a speedup. Do not compare unpaired session
averages as if the tasks, models, and accepted outcomes were controlled.

## Claude Code specifics

LeanLoop 0.5.0 and later target Claude Code only. Install it once as a plugin;
every project then sees `/leanloop:work`, `/leanloop:setup`, `/leanloop:audit`,
`/leanloop:review`, `/leanloop:build`, and the `leanloop-reviewer` and
`leanloop:code-reviewer` agents. A project needs only `leanloop.json` and the ignored
`.leanloop/` folder, which `/leanloop:setup` creates.

Claude Code also loads CLAUDE.md files from parent folders and your user folder,
everything they `@import`, and `.claude/rules` files without `paths`. Run
`/leanloop:audit` to see them. If a new session still launches a mandatory role
chain, inspect those sources before adding another rule. Plugins cannot ship
permission rules, so Claude Code asks before running the CLI until you allow it.

For a team, commit the marketplace and plugin to the shared project settings so
members are prompted to install it:

```json
{
  "extraKnownMarketplaces": {
    "leanloop": { "source": { "source": "github", "repo": "seyedalicheraghi/LeanLoop-" } }
  },
  "enabledPlugins": { "leanloop@leanloop": true }
}
```

## Rollback and maintenance

1. Stop the current task or record a cancellation; do not leave checks running.
2. Disable or uninstall the plugin with `/plugin` (or `claude plugin disable
   leanloop@leanloop`). Project files are untouched.
3. Delete `leanloop.json`, `leanloop.lessons.md`, and `.leanloop/` only if you
   no longer want the configuration, lessons, or task history.

There is intentionally no uninstall command that deletes project files. Plugin
updates arrive when the plugin version changes; run `/plugin` to update. Task
evidence recorded by an older runtime may be stale or ungated after an update:
rerun checks and record fresh proof and review rather than editing stored state.

## Moving from 0.5 to 0.6

Update the plugin with `/plugin`. `leanloop.json` and lessons keep their
format, and nothing in the project needs to change. What is new or stricter:

1. **Finish any task started under 0.5 first, or start a new one.** 0.6 adds
   start-time manifests and digests of Git-ignored check definitions to a
   task's base. A 0.5 task has no manifest, so it is still compared with its
   recorded commit; start a new task to get the full gate.
2. **More changes need a review before `finish`.** Besides edited tests and
   changed `leanloop.json` checks, `INTEGRITY_REVIEW_REQUIRED` now covers
   check-definition files (`package.json` scripts and runner settings,
   `pyproject.toml` tool sections, Makefiles, pytest, tox, Jest, Vitest, and
   similar configs, `conftest.py`, `.npmrc`, and files your check commands
   name) and checks that failed and then passed on the same source. Edits
   outside `--scope` alone give `SCOPE_REVIEW_REQUIRED`. A task in a repository
   without commits is now gated through a hash manifest instead of being
   reported as unavailable.
3. **Escalation is a real stop.** `finish` refuses with `ESCALATED` until
   `resume --decision "..."` records your decision. Claude is told to quote
   you and never to resume on its own. Scripts that called `finish` after
   `escalate` must add the `resume` step.
4. **Budget.** Only the first two runs on the unchanged starting source are
   free; further reruns there use the attempt budget.
5. **New commands, all user-invoked:** `/leanloop:review` runs the new
   `leanloop:code-reviewer` agent, and `/leanloop:build` runs swarm mode (see
   the [swarm guide](swarm.md)). Swarm runs create branches named
   `leanloop/swarm/RUN` and `leanloop/swarm/RUN-PACKAGE` and worktrees under
   `.leanloop/worktrees/`; `swarm abandon` removes them.
6. **Audit** now also reports `CLAUDE.local.md` in parent folders and AGENTS.md
   files, including ones a CLAUDE file shadows (`AGENTS_MD_SHADOWED`).
7. **Budgets.** All skills and agents together may use 24 KiB (12 KiB in
   0.5.1), and the code reviewer has its own 8 KiB; the work skill plus
   `leanloop-reviewer` stay within 8 KiB. If you fork the skills,
   `npm run validate` checks them.

## Moving from 0.4.0 (per-project copies) to the plugin

LeanLoop 0.4.0 copied the skill and reviewer into each project
(`.claude/skills/leanloop/`, `.agents/skills/leanloop/`, `.github/skills/leanloop/`,
`leanloop-reviewer` agent files) and kept a registry in `.leanloop/install.json`.
With the plugin installed those copies duplicate it.

1. Finish or cancel any active task with the old runtime.
2. Install the plugin and run `/leanloop:setup` (or `init`). It keeps your
   `leanloop.json` and lists the old copies it found as `vendoredCopies`.
3. Compare each listed copy with the 0.4.0 release, then delete it yourself,
   along with `.leanloop/install.json`. LeanLoop never deletes them for you.
4. Tasks started under 0.4.0 have no integrity base; start new tasks to get the
   test-integrity gate.

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
5. Install the 0.5.0 plugin and run `/leanloop:setup`; the 0.4.0 names in the
   table above are the per-project copies the plugin replaces.
