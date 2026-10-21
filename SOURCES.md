# Sources and provenance

Reviewed on 2026-10-20 (0.1.0) and reassessed for 0.2.0 and 0.3.0 the same day.
Version 0.4.0 renamed the project from lean-workflow to LeanLoop. Version 0.5.0
made it a Claude Code plugin and added the [research review](#research-reviewed-for-050)
below. This implementation, its prompts, and its tests were written independently. No
third-party runtime code or skill text is vendored. The MIT license covers this
package's original files; source references do not relicense upstream work or
determine rights outside this package.

## Public repositories and engineering guidance

LeanLoop is based on the first two projects below. The others informed specific
design choices.

| Source | What informed this package | What was not assumed |
|---|---|---|
| [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd/tree/1ecea1993b7fce257ffbd686c070948b5e07eda6), MIT (still HEAD on 2026-10-20) | Actionable presentation: outcome first, numbered steps, restated state, one next action, capped visible lists; one skill shipped to many hosts | It is an output-style skill, not a faster coding engine; no diagnosis, clinical generalizations, forced causes, or mandatory time estimates were adopted |
| [WorldFlowAI/everything-claude-code](https://github.com/worldflowai/everything-claude-code), which builds on [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) (MIT; now served as `affaan-m/ECC`); local historical snapshot reviewed at `432485b` | Plugin packaging (`.claude-plugin/` with a marketplace whose source is the repository root, `${CLAUDE_PLUGIN_ROOT}` paths); its verify, checkpoint, and learn workflows became bounded CLI commands (`check`, `checkpoint`, `learn`) with recorded evidence; its build-fix stop rule (stop after repeated failures) became the escalation path | Its catch-all and per-edit hooks, uncapped learned-memory files, model-pinned role agents, and prompt-only gates. A 2026-10-20 review of the WorldFlowAI copy found most hook matchers never fire and its learned memory is written where Claude Code never reads it, so the lesson is to test read paths and enforce gates in code. That copy's README states MIT but it has no LICENSE file; the upstream has the MIT text. No text from either was reused |
| [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent), MIT; [design explanation](https://mini-swe-agent.com/latest/) | Small understandable control flow, fewer framework layers | Its benchmark scores do not predict this package's success rate; no source copied |
| [Aider](https://github.com/Aider-AI/aider), Apache-2.0; [repository maps](https://aider.chat/docs/repomap.html) | Context should be relevant and budgeted rather than a repository dump | This kit's filename ranking is not Aider's symbol/dependency graph or a substitute for it |
| [Agentless](https://github.com/OpenAutoCoder/Agentless), MIT | Separate localization, repair, and validation as phases, not necessarily agents | A constrained repair benchmark is not all software engineering |
| [12-Factor Agents](https://github.com/humanlayer/12-factor-agents) | Explicit control flow, state ownership, focused context | Upstream distinguishes Apache-2.0 code and CC BY-SA 4.0 content; only general ideas and a reference are used here |
| [Building effective agents](https://www.anthropic.com/research/building-effective-agents) | Start with the simplest useful approach; add complexity for a demonstrated benefit | Practitioner guidance from 2024, not a controlled comparison or a current product recommendation |

### Similar workflow kits (surveyed, not used)

| Kit | Approach | License |
|---|---|---|
| [obra/superpowers](https://github.com/obra/superpowers) | Composable skills, design approval, TDD, and subagent-driven development; this kit keeps the verification ideas without requiring that execution architecture | [MIT](https://github.com/obra/superpowers/blob/main/LICENSE) |
| [github/spec-kit](https://github.com/github/spec-kit) | Structured processes/templates; specification, bug fixing, and assessment are separate entry points, not one mandatory chain | [MIT](https://github.com/github/spec-kit/blob/main/LICENSE) |
| [bmad-code-org/BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) | Agile method with many role agents (analyst, architect, developer, QA) | [MIT](https://github.com/bmad-code-org/BMAD-METHOD/blob/main/LICENSE) |
| [SuperClaude-Org/SuperClaude_Framework](https://github.com/SuperClaude-Org/SuperClaude_Framework) | Commands, personas, and modes layered on Claude Code | MIT |
| [wshobson/agents](https://github.com/wshobson/agents) | Large catalog of specialist agents and plugins for several hosts | MIT |
| [eyaltoledano/claude-task-master](https://github.com/eyaltoledano/claude-task-master) | Task decomposition and tracking driven by an AI model | Custom |

The role-per-agent pattern of several of these kits is the pattern this package
avoids imposing on sequential coding work. Skills and multi-agent execution are
independent design choices, not opposing categories. No
cost, speed, or quality claim about any of them is made here.

### The output-style project's own evidence

Its pinned [evaluation results](https://github.com/ayghri/i-have-adhd/blob/1ecea1993b7fce257ffbd686c070948b5e07eda6/evals/RESULTS.md)
report a failed release gate despite improved weighted rubric scores (4.045 to
4.473 over 14 cases and 3 trials). The largest gains were in progress and error
reports. They identify a task whose runner had no tools to perform the requested
edit, and a regression the author suspects came from requiring "cause, then fix",
which can push an unsupported cause; three trials could not confirm it.

That is useful evidence against copying a style policy blindly. This kit
separates observed facts from uncertainty, writes "cause unknown" when evidence
does not show a cause, does not prescribe speculative time estimates, and keeps
brevity subordinate to correctness and requested detail. The reported small
sample and same-family judge do not establish broad efficacy.

## Engineering reports on agent architecture and context

- Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
  (2025): multi-agent systems used about 15x the tokens of chats; token usage
  explained 80% of performance variance on BrowseComp; most coding tasks have fewer truly
  parallelizable parts than research and are not a good fit today.
  The 15x figure compares their research system with chat, not this kit with a
  single coding agent. It is not a transferable cost multiplier or savings estimate.
- Cognition, [Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents)
  (2025) and [Multi-Agents: What's Actually Working](https://cognition.ai/blog/multi-agents-working)
  (2026): share full context; parallel writers make conflicting implicit decisions;
  what works is several agents contributing intelligence while writes stay
  single-threaded, such as read-only search helpers and review loops.
- Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  (2025): context is a finite attention budget; prefer just-in-time retrieval,
  compaction, and structured notes over preloading.
- Chroma, [Context Rot](https://www.trychroma.com/research/context-rot) (2025): model
  performance degrades as input length grows, even on simple tasks.

## Primary papers

1. **Agentless: Demystifying LLM-based Software Engineering Agents**
   (arXiv:2407.01489, initially July 2024).
   [Paper, v2](https://arxiv.org/html/2407.01489v2).
   The localization/repair/validation approach motivates a small explicit loop.
   Results concern the paper's models, benchmark, and candidate-selection process;
   they do not demonstrate that every multi-agent design is worse.

2. **Why Do Multi-Agent LLM Systems Fail?**
   (arXiv:2503.13657, initially March 2025).
   [Paper](https://arxiv.org/html/2503.13657).
   Over 1,600 annotated traces from seven frameworks, with 41-86.7% failure rates
   and a taxonomy covering system design, inter-agent misalignment, and task
   verification. These motivate clear ownership, bounded handoff packets, and
   explicit completion evidence. The taxonomy is not exhaustive and does not
   isolate the cost of this package or any particular private workflow.

3. **Towards a Science of Scaling Agent Systems**
   (arXiv:2512.08296, initially December 2025).
   [Paper](https://arxiv.org/abs/2512.08296).
   Controlled evaluation of 260 configurations, five architectures, and three model
   families. Relative to a single agent, results ranged from +80.8% on decomposable
   financial reasoning to -70.0% on sequential planning; tool-heavy tasks incurred
   multi-agent overhead; architectures without centralized verification propagated
   errors more. No numerical saving from this paper is represented as this kit's
   performance.

4. **SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering**
   (arXiv:2405.15793, 2024). [Paper](https://arxiv.org/abs/2405.15793).
   A purpose-built interface (capped search, a windowed file viewer, linted edits)
   beat raw shell access, and capped search beat unbounded iterative search; this
   motivates bounded CLI output.

5. **Lost in the Middle: How Language Models Use Long Contexts**
   (arXiv:2307.03172, 2023). [Paper](https://arxiv.org/abs/2307.03172).
   Information in the middle of long inputs is used least; one reason for capped
   memory and small always-on instructions.

6. **Agentic Context Engineering** (arXiv:2510.04618, October 2025).
   [Paper](https://arxiv.org/abs/2510.04618).
   Incremental edits avoid "context collapse" from wholesale rewriting, while
   de-duplication and a pruning cap keep the playbook from growing without bound;
   this motivates replace-one-entry lessons with a hard cap rather than append-only
   logs or full rewrites.

7. **Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding
   Agents?** (arXiv:2602.11988, February 2026).
   [Paper, v1](https://arxiv.org/html/2602.11988v1);
   [evaluation repository](https://github.com/eth-sri/agentbench).
   The study uses 138 Python tasks across 12 repositories, plus SWE-bench Lite.
   In its setting, developer-written context files slightly helped on average and
   raised costs by up to 19%; generated files slightly hurt and raised costs by over
   20%. Neither accuracy effect was statistically significant.
   This motivates minimal, useful repository requirements and task-level evaluation,
   not automatically generating more instructions or banning all context files.
   It does not test this package's skill or establish a universal result.

### Reassessment boundaries

The public sources justify testing a lightweight default, not declaring one
architecture universally faster. Static configuration sizes, old session usage
averages, and tiny-file scalability tests are different measurements. Cache
behavior, host-specific discovery, actual tool traces, task mix, and accepted
outcomes must be measured before claiming provider savings or a root cause for
decreased capability. No private source code, prompts, or runtime data was sent
to public research tools, and no upstream implementation was copied.

## Research reviewed for 0.5.0

On 2026-10-20, six parallel literature reviews covered arXiv work on coding-agent
architecture, context, memory, verification, security, and practice and
evaluation. Every ID below was checked against arXiv's own metadata. A second
pass the same day checked every quoted figure and statement in this file and in
the docs against each source's full text (61 claims, including the earlier
sections and non-arXiv posts): none was contradicted or unsupported, 19 needed
corrected figures or wording, and about 18 more were narrowed to their exact
scope. Most 2026 entries are unreviewed preprints, often with one model, one
harness, or a small task set; none of them evaluated LeanLoop. They justify
design choices, not performance claims.

### Architecture and delegation

| Paper | Finding | Effect on LeanLoop |
|---|---|---|
| [2609.04898](https://arxiv.org/abs/2609.04898) RefactorPlatform | A lean single agent with retrieval scored 86% against 66% for a sub-agent setup on 100 matched refactoring tasks (one model, one run) | One owner stays the default |
| [2609.32459](https://arxiv.org/abs/2609.32459) Harness effects | Task-specific sub-agents and a tool registry helped; general sub-agents and context compression hurt; harness gains shrank with stronger models on issue repair, not on ProgramBench | Delegate only narrow read-only questions or review; audit flags agents with every tool |
| [2610.17471](https://arxiv.org/abs/2610.17471) Teams of coding agents | Teams beat a solo agent at 3-7x the cost; delegating only planning matched full delegation at half the cost; cheap implementers lowered reward | No implementation hand-offs to other agents |
| [2603.26458](https://arxiv.org/abs/2603.26458) Can AI models direct each other? | With a strong manager directing a weak worker, a review-only loop added 2 points; structured exploration plus planning added 11 over the baseline (9 beyond the loop) | Scope and acceptance criteria before editing |
| [2606.05670](https://arxiv.org/abs/2606.05670) Do more agents help? | 1 of 6 multi-agent workflows beat a single agent (+3.05 points at 1.27x tokens); the costliest used 4.34x and still trailed | Same |
| [2606.13733](https://arxiv.org/abs/2606.13733) Task structure limits multi-agent success | In theory, success falls exponentially with how tightly a task's parts are coupled; the empirical check was weak (r = -0.33) | Parallel writers only for genuinely separable work |
| [2608.16801](https://arxiv.org/abs/2608.16801) When agents coordinate | In Claude Code runs, a coordinator gave no reliable gain, and an agent opened a decoy hidden-test file in 80% of 244 sealed runs | Gates are not tamper-proof; review stays separate |
| [2606.20615](https://arxiv.org/abs/2606.20615) AI-SDLC protocol language | The same bug-fix method gained nothing as prose but up to 22 points when executed as an enforced process (one model family) | Gates live in the CLI, not only in the skill |
| [2605.12925](https://arxiv.org/abs/2605.12925) AgentLens | 10.7% of 1,136 passing runs were "lucky passes" showing regression cycles, blind retries, or missing verification | Check history and `observedFailToPass` |
| [2610.01618](https://arxiv.org/abs/2610.01618) Agents are systems | Telling an agent to verify barely changed how it verified; an oracle verification tool roughly tripled verification | Same |

### Verification and test integrity

| Paper | Finding | Effect on LeanLoop |
|---|---|---|
| [2510.20270](https://arxiv.org/abs/2510.20270) ImpossibleBench | Models exploited impossible tests (GPT-5: 76% on Oneoff-SWEbench); over 79% of Claude and Qwen3-Coder cheating on Conflicting-SWEbench edited tests; allowing multiple submissions raised cheating from 33% to 38% | Integrity gate for edited or deleted tests; fixed attempt budget |
| [2511.21654](https://arxiv.org/abs/2511.21654) EvilGenie | On unambiguous problems, Claude Code wrote non-general solutions in 20.7% of runs; hard-coding (at most 2.1%) and deleting test files (Gemini CLI, 3.4%) were rare | Reviewer checks test diffs and special-casing first |
| [2608.29460](https://arxiv.org/abs/2608.29460) Escalation channels | Pooled over 8 models, an escalation tool plus a written policy cut test hacking from 23.6% to 5.3% with no detectable solve-rate cost (9 defective problems) | `escalate` with kind, summary, approaches tried, and recommendation |
| [2503.15223](https://arxiv.org/abs/2503.15223) Are solved issues solved? | 29.6% of plausible SWE-bench Verified patches from three tools behaved differently from the reference fix; about 11% were estimated to be certainly wrong | All checks must pass, plus per-criterion evidence |
| [2406.12952](https://arxiv.org/abs/2406.12952) SWT-Bench and [2502.05368](https://arxiv.org/abs/2502.05368) Otter | Tests that fail before and pass after a fix sharply raise patch precision at a large recall cost, and are generated for only a minority of issues (9-37% across the tested systems) | Regression test first; red-then-green is reported, not forced |
| [2606.18168](https://arxiv.org/abs/2606.18168) All smoke, no alarm | 80.2% of agent-written test patches had weak or no assertions | Reviewer looks for weakened assertions |
| [2609.20812](https://arxiv.org/abs/2609.20812) Overclaiming | Agents left assigned files unread in 67.9% of runs; 80.4% of those runs overclaimed coverage or hid the gap | Reports come from the CLI's recorded results |
| [2603.00539](https://arxiv.org/abs/2603.00539) LLM code reviewers | Models often judged correct code non-compliant; executing the proposed fix cut errors | Reviewer backs each blocking finding with a failing input or command |
| [2306.09896](https://arxiv.org/abs/2306.09896) Self-repair and [2609.10123](https://arxiv.org/abs/2609.10123) blind repair | Repair gains are modest once cost counts; repeated blind edits damage correct programs | Each attempt needs new information |

### Context

| Paper | Finding | Effect on LeanLoop |
|---|---|---|
| [2608.26130](https://arxiv.org/abs/2608.26130) Agents don't paginate | In one middleware's logs, agents never requested a second chunk of truncated output | Failed checks return an output excerpt with the result |
| [2509.23586](https://arxiv.org/abs/2509.23586) AgentDiet and [2508.21433](https://arxiv.org/abs/2508.21433) Complexity trap | An LLM pass that trimmed useless and expired trajectory content cut cost 21-36% with little quality change; simple observation masking matched LLM summarization at about half the cost | Bounded logs; no summarization model |
| [2607.24882](https://arxiv.org/abs/2607.24882) Agent retrieval bench | A vectorless repository map narrowly led weighted context yield at 8K; logged agents never touched a gold file in 27-35% of samples | Start from ranked hits, then stop widening |
| [2608.01507](https://arxiv.org/abs/2608.01507) Deep agentic search | 41.8% of deep-agent failures were planner-to-subagent hand-off breakdowns, mostly with confident answers | Helpers return file:line evidence the owner re-checks |
| [2604.11088](https://arxiv.org/abs/2604.11088) Guardrails beat guidance | Random rule files matched curated ones (a direction, not a significant result); the individually helpful rules were prohibitions | Hard rules phrased as "do not" |
| [2605.10039](https://arxiv.org/abs/2605.10039) Instruction adherence | File size and position had no detectable effect; compliance decayed within sessions (an exploratory finding) | Re-run `status` before finishing; audit reports size as cost, not quality |
| [2602.12670](https://arxiv.org/abs/2602.12670) SkillsBench | Focused, curated skills helped; self-generated ones did not | Three small skills; lessons stay curated |
| [2510.05381](https://arxiv.org/abs/2510.05381) Context length alone hurts | Accuracy fell with input length even with perfect retrieval | Bounded outputs and memory |
| [2604.22750](https://arxiv.org/abs/2604.22750) Token spend | Token use for one task typically varied about 2x across runs (the authors cite up to 30x) | Evaluation uses repeated trials |
| [2511.12884](https://arxiv.org/abs/2511.12884) Agent READMEs | Context files mostly describe testing, implementation, and architecture; 14.8% mention security | Audit notes a missing test command |

### Memory

| Paper | Finding | Effect on LeanLoop |
|---|---|---|
| [2610.27524](https://arxiv.org/abs/2610.27524) MemDev-Bench | Every memory system broke tasks the no-memory agent solved, mostly by misapplying old experience | Lessons are hints to re-check |
| [2610.27377](https://arxiv.org/abs/2610.27377) REM | A small phase-structured memory helped weaker models but lowered resolution for stronger ones | Lessons stay capped |
| [2610.04838](https://arxiv.org/abs/2610.04838) MemTrace | A memory bound to files and tests that re-checks entries against the current repository helped overall; the re-check itself was not isolated | `--anchor` with stale flags |
| [2505.16067](https://arxiv.org/abs/2505.16067) Memory management | Storing every experience did worse than a fixed memory; verified-only storage did best | Lessons need evidence from a check |
| [2608.11095](https://arxiv.org/abs/2608.11095) Why CLAUDE.md keeps growing | Instruction files grow by accretion; in a synthetic test, annotating rules with their outcomes curbed growth | Near-duplicate refusal and an explicit cap |
| [2610.11007](https://arxiv.org/abs/2610.11007) Curating always-loaded context | Per-rule compliance fell sharply at very large rule counts; a proof shows pruning ignored rules can drop helpful ones | Replacement stays a human decision |
| [2609.13889](https://arxiv.org/abs/2609.13889) Persistent memory poisoning | Instructions planted in external content persisted into later sessions | Never store lessons from external content |

### Security

| Paper | Finding | Effect on LeanLoop |
|---|---|---|
| [2607.20759](https://arxiv.org/abs/2607.20759) IssueTrojanBench | Agents followed injected instructions in 66.5% of issue-fixing runs, including edits to CLAUDE.md-style config and hidden scripts; hidden payloads matched visible ones | Do not change agent config unless asked; list config changes in the report |
| [2608.30686](https://arxiv.org/abs/2608.30686) Beyond the payload | "Run the tests" tasks were the riskiest; security rules alone did not lower attack success | Read what a script runs before running it; docs recommend a sandbox |
| [2406.13352](https://arxiv.org/abs/2406.13352) AgentDojo and [2506.08837](https://arxiv.org/abs/2506.08837) Design patterns | AgentDojo's tool filter cut GPT-4o's targeted attack success from 57.7% to 6.8%; the design-patterns paper argues untrusted input must not trigger consequential actions | Read-only reviewer; untrusted content treated as data |
| [2406.10279](https://arxiv.org/abs/2406.10279) Package hallucinations | Commercial models hallucinated packages in 5.2% of samples on average, open-source models in 21.7% | Never install packages named only in untrusted text |
| [2601.10338](https://arxiv.org/abs/2601.10338) Agent skills in the wild | 26.1% of marketplace skills had a vulnerability; bundled scripts raised the odds | LeanLoop ships no hooks or MCP servers; validation pins the layout |
| [2603.00164](https://arxiv.org/abs/2603.00164) Reverse CAPTCHA | Invisible Unicode instructions were followed far more often when tools were available, especially with decoding hints | Audit and validation flag invisible and bidirectional characters |

### Practice and evaluation

| Paper | Finding | Effect on LeanLoop |
|---|---|---|
| [2605.18583](https://arxiv.org/abs/2605.18583) Overeager coding agents | In Claude Code, removing an explicit scope statement raised out-of-scope actions by 12-17 points across three models (GLM-4.6: 0% to 17.1%) | `start --scope` and "do not touch outside the scope" |
| [2507.09089](https://arxiv.org/abs/2507.09089) METR RCT | Experienced developers took 19% longer with early-2025 AI, yet afterwards estimated they had been 20% faster | Measure with timed logs, never impressions |
| [2602.07150](https://arxiv.org/abs/2602.07150) Randomness in agentic evals | Single-run scores shift by 2.2-6.0 points between runs | Repeated trials, pass@k and pass^k |
| [2411.00640](https://arxiv.org/abs/2411.00640) Error bars | Use task-clustered and paired standard errors | Paired comparison in `compare-runs` |
| [2406.12045](https://arxiv.org/abs/2406.12045) tau-bench | pass^k measures reliability across trials | Same |
| [2407.01502](https://arxiv.org/abs/2407.01502) AI agents that matter | Report cost and accuracy together; use holdouts | Evaluation procedure |

### Multi-component procedure (0.5.1)

Each rule in the work skill's "Multi-component changes" section, with what backs it:

| Rule | Backing | Strength |
|---|---|---|
| Map with one read-only helper and verify its file:line output | Cognition's [2026 post](https://cognition.ai/blog/multi-agents-working): read-only search helpers work while writes stay single-threaded. [2608.01507](https://arxiv.org/abs/2608.01507): 41.8% of deep-agent failures were planner-to-subagent hand-off breakdowns, mostly with confident answers. Claude Code [best practices](https://code.claude.com/docs/en/best-practices): subagents suit tasks that read many files | Practitioner report, one empirical study, vendor guidance |
| Split into smaller tasks, one per component | [2510.05381](https://arxiv.org/abs/2510.05381): accuracy fell with input length even with perfect retrieval. [2606.13733](https://arxiv.org/abs/2606.13733): in theory, success falls as a task's parts become more tightly coupled; its empirical check was weak | An inference from these findings, not a tested result |
| A component is its own task only if it leaves all checks green; otherwise one task, testing each component directly, then one `check` | LeanLoop's own `finish` gate and attempt budget | Design consequence, not research |
| Checkpoint the remaining steps; clearing the context between steps is safe | [2510.05381](https://arxiv.org/abs/2510.05381); [2605.10039](https://arxiv.org/abs/2605.10039): compliance decayed within sessions (an exploratory finding); Claude Code [best practices](https://code.claude.com/docs/en/best-practices): clear between tasks, since long sessions with irrelevant context can reduce performance | Controlled and exploratory studies, vendor guidance |

Advice to add a new interface form, migrate consumers, then remove the old form
was considered and left out: no study in this review tests it.

## Agent validation

The behavior eval suite and the validation guidance follow Claude Code's plugin
evals and the frameworks, practitioner guides, and papers listed in
[Validating agents](docs/agent-validation.md#sources), checked on 2026-10-20.

## Runtime and format references

- [Claude Code plugins](https://code.claude.com/docs/en/plugins/components),
  [plugin manifest](https://code.claude.com/docs/en/plugins/manifest-reference), and
  [marketplaces](https://code.claude.com/docs/en/plugins/create-marketplace):
  `.claude-plugin/plugin.json`, components at the plugin root,
  `${CLAUDE_PLUGIN_ROOT}` substitution in skill text, and no plugin-shipped permissions.
- [Claude Code skills](https://code.claude.com/docs/en/skills) and
  [subagents](https://code.claude.com/docs/en/sub-agents): frontmatter,
  `/plugin:skill` namespacing, `disable-model-invocation`, and read-only tool lists.
- [Claude Code memory](https://code.claude.com/docs/en/memory): CLAUDE.md load
  order including parent folders, `@imports`, and `.claude/rules` with `paths`.
- [Claude Code permissions](https://code.claude.com/docs/en/permissions) and
  [best practices](https://code.claude.com/docs/en/best-practices).
- [Agent Skills specification](https://agentskills.io/specification): skill
  structure and progressive disclosure.
- [Node child processes](https://nodejs.org/api/child_process.html):
  argument arrays, process creation, signal behavior, and `.cmd` handling on Windows.
- [Git diff](https://git-scm.com/docs/git-diff) and
  [Git ls-files](https://git-scm.com/docs/git-ls-files):
  repository-visible changes and path inventories.

## What remains to establish

Automated local tests establish specific implementation behaviors, not general
engineering capability. A real cost/latency comparison requires controlled runs
on representative projects, provider-reported usage, and acceptance outcomes.
See the [evaluation procedure](docs/evaluation.md). No paid provider comparison
or assertion of defect-free behavior is included.
