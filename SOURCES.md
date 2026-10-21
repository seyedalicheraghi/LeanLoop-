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
report a failed release gate despite improved aggregate style scores (weighted
4.045 to 4.473 over 14 cases and 3 trials). The largest gains were in progress
and error reports. They identify a task whose runner had no tools to perform the
requested edit, and a regression where requiring "cause, then fix" encouraged an
unsupported cause.

That is useful evidence against copying a style policy blindly. This kit
separates observed facts from uncertainty, writes "cause unknown" when evidence
does not show a cause, does not prescribe speculative time estimates, and keeps
brevity subordinate to correctness and requested detail. The reported small
sample and same-family judge do not establish broad efficacy.

## Engineering reports on agent architecture and context

- Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
  (2025): multi-agent systems used about 15x the tokens of chats; token usage
  explained most performance variance; most coding tasks have fewer truly
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
- Chroma, [Context Rot](https://research.trychroma.com/context-rot) (2025): model
  accuracy degrades as input length grows, well before context limits.

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
   Purpose-built, bounded navigation and search tools improved an agent more than
   raw shell access; this motivates bounded CLI output.

5. **Lost in the Middle: How Language Models Use Long Contexts**
   (arXiv:2307.03172, 2023). [Paper](https://arxiv.org/abs/2307.03172).
   Information in the middle of long inputs is used least; one reason for capped
   memory and small always-on instructions.

6. **Agentic Context Engineering** (arXiv:2510.04618, October 2025).
   [Paper](https://arxiv.org/abs/2510.04618).
   Evolving playbooks with small incremental edits avoid both unbounded growth and
   "context collapse" from wholesale rewriting; this motivates replace-one-entry
   lessons rather than append-only logs or full rewrites.

7. **Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding
   Agents?** (arXiv:2602.11988, February 2026).
   [Paper, v1](https://arxiv.org/html/2602.11988v1);
   [evaluation repository](https://github.com/eth-sri/agentbench).
   The study uses 138 Python tasks across 12 repositories, plus SWE-bench Lite.
   In its setting, developer-written context files slightly helped on average,
   generated files slightly hurt, and context files increased costs by over 20%.
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
evaluation. Every ID below was checked against arXiv's own metadata. Most 2026
entries are unreviewed preprints, often with one model, one harness, or a small
task set; none of them evaluated LeanLoop. They justify design choices, not
performance claims.

### Architecture and delegation

| Paper | Finding | Effect on LeanLoop |
|---|---|---|
| [2609.04898](https://arxiv.org/abs/2609.04898) RefactorPlatform | A lean single agent with retrieval scored 86% against 66% for a sub-agent setup on matched refactoring tasks | One owner stays the default |
| [2609.32459](https://arxiv.org/abs/2609.32459) Harness effects | Task-specific sub-agents and a tool registry helped; general-purpose sub-agents and context compression hurt; returns diminish as models improve | Delegate only narrow read-only questions or review; audit flags agents with every tool |
| [2610.17471](https://arxiv.org/abs/2610.17471) Teams of coding agents | Teams beat a solo agent at 3-7x the cost; delegating only planning matched full delegation at half the cost; cheap implementers lowered reward | No implementation hand-offs to other agents |
| [2603.26458](https://arxiv.org/abs/2603.26458) Can AI models direct each other? | A review-only loop added 2 points; structured exploration plus planning added 11 | Scope and acceptance criteria before editing |
| [2606.05670](https://arxiv.org/abs/2606.05670) Do more agents help? | 1 of 6 multi-agent workflows beat a single agent, at up to 4.34x the tokens | Same |
| [2606.13733](https://arxiv.org/abs/2606.13733) Task structure limits multi-agent success | Success falls with how tightly a task's parts are coupled | Parallel writers only for genuinely separable work |
| [2608.16801](https://arxiv.org/abs/2608.16801) When agents coordinate | A coordinator gave no reliable gain; agents searched for hidden grading material in about 4 of 5 sealed runs | Gates are not tamper-proof; review stays separate |
| [2606.20615](https://arxiv.org/abs/2606.20615) AI-SDLC protocol language | The same bug-fix method gained nothing as prose but 14-22 points when enforced as a process | Gates live in the CLI, not only in the skill |
| [2605.12925](https://arxiv.org/abs/2605.12925) AgentLens | 10.7% of passing runs were "lucky passes" from blind retries or no verification | Check history and `observedFailToPass` |
| [2610.01618](https://arxiv.org/abs/2610.01618) Agents are systems | Telling an agent to verify changed little; a dedicated verification tool changed behavior | Same |

### Verification and test integrity

| Paper | Finding | Effect on LeanLoop |
|---|---|---|
| [2510.20270](https://arxiv.org/abs/2510.20270) ImpossibleBench | Models exploited tests on impossible tasks (GPT-5: 76% on one variant); over 79% of Claude cheating transcripts modified tests; more submissions raised cheating | Integrity gate for edited or deleted tests; fixed attempt budget |
| [2511.21654](https://arxiv.org/abs/2511.21654) EvilGenie | Agents deleted test files, hard-coded tests, or wrote non-general solutions | Reviewer checks test diffs and special-casing first |
| [2608.29460](https://arxiv.org/abs/2608.29460) Escalation channels | An escalation tool plus a written policy cut test hacking from 23.6% to 5.3% with no detectable solve-rate cost (9 problems) | `escalate` with kind, summary, approaches tried, and recommendation |
| [2503.15223](https://arxiv.org/abs/2503.15223) Are solved issues solved? | 29.6% of plausible SWE-bench patches behaved differently from the reference fix | All checks must pass, plus per-criterion evidence |
| [2406.12952](https://arxiv.org/abs/2406.12952) SWT-Bench and [2502.05368](https://arxiv.org/abs/2502.05368) Otter | Tests that fail before and pass after a fix sharply raise patch precision, but reproduction often fails | Regression test first; red-then-green is reported, not forced |
| [2606.18168](https://arxiv.org/abs/2606.18168) All smoke, no alarm | 80.2% of agent-written test patches had weak or no assertions | Reviewer looks for weakened assertions |
| [2609.20812](https://arxiv.org/abs/2609.20812) Overclaiming | Agents skipped assigned files in 67.9% of runs and misreported it in most | Reports come from the CLI's recorded results |
| [2603.00539](https://arxiv.org/abs/2603.00539) LLM code reviewers | Models often judged correct code non-compliant; executing the proposed fix cut errors | Reviewer backs each blocking finding with a failing input or command |
| [2306.09896](https://arxiv.org/abs/2306.09896) Self-repair and [2609.10123](https://arxiv.org/abs/2609.10123) blind repair | Repair gains are modest once cost counts; repeated blind edits damage correct programs | Each attempt needs new information |

### Context

| Paper | Finding | Effect on LeanLoop |
|---|---|---|
| [2608.26130](https://arxiv.org/abs/2608.26130) Agents don't paginate | Agents almost never request a second chunk of truncated output | Failed checks return an output excerpt with the result |
| [2509.23586](https://arxiv.org/abs/2509.23586) AgentDiet and [2508.21433](https://arxiv.org/abs/2508.21433) Complexity trap | Removing verbose logs and old observations cut cost with little quality change; masking matched LLM summarization | Bounded logs; no summarization model |
| [2607.24882](https://arxiv.org/abs/2607.24882) Agent retrieval bench | Budgeted repository maps gave the best context at 8K; logged agents never touched a gold file in 27-35% of samples | Start from ranked hits, then stop widening |
| [2608.01507](https://arxiv.org/abs/2608.01507) Deep agentic search | 41.8% of failures were planner-to-subagent hand-off breakdowns, usually with confident answers | Helpers return file:line evidence the owner re-checks |
| [2604.11088](https://arxiv.org/abs/2604.11088) Guardrails beat guidance | Random rule files matched curated ones; helpful rules were prohibitions | Hard rules phrased as "do not" |
| [2605.10039](https://arxiv.org/abs/2605.10039) Instruction adherence | File size and position showed no effect; compliance decayed within a session | Re-run `status` before finishing; audit reports size as cost, not quality |
| [2602.12670](https://arxiv.org/abs/2602.12670) SkillsBench | Focused, curated skills helped; self-generated ones did not | Three small skills; lessons stay curated |
| [2510.05381](https://arxiv.org/abs/2510.05381) Context length alone hurts | Accuracy fell with input length even with perfect retrieval | Bounded outputs and memory |
| [2604.22750](https://arxiv.org/abs/2604.22750) Token spend | Token use for one task varied up to 30x across runs | Evaluation uses repeated trials |
| [2511.12884](https://arxiv.org/abs/2511.12884) Agent READMEs | Context files mostly describe tests and builds; 14.8% mention security | Audit notes a missing test command |

### Memory

| Paper | Finding | Effect on LeanLoop |
|---|---|---|
| [2610.27524](https://arxiv.org/abs/2610.27524) MemDev-Bench | Every memory system broke tasks the no-memory agent solved, mostly by misapplying old experience | Lessons are hints to re-check |
| [2610.27377](https://arxiv.org/abs/2610.27377) REM | A small phase-structured memory helped weaker models but lowered resolution for stronger ones | Lessons stay capped |
| [2610.04838](https://arxiv.org/abs/2610.04838) MemTrace | Memory tied to files and re-checked against the current repository before reuse helped | `--anchor` with stale flags |
| [2505.16067](https://arxiv.org/abs/2505.16067) Memory management | Storing every experience did worse than a fixed memory; verified-only storage did best | Lessons need evidence from a check |
| [2608.11095](https://arxiv.org/abs/2608.11095) Why CLAUDE.md keeps growing | Instruction files grow by accretion; recording outcome with each rule curbed growth | Near-duplicate refusal and an explicit cap |
| [2610.11007](https://arxiv.org/abs/2610.11007) Curating always-loaded context | Compliance per rule collapsed as rule count grew; pruning ignored rules can remove helpful ones | Replacement stays a human decision |
| [2609.13889](https://arxiv.org/abs/2609.13889) Persistent memory poisoning | Instructions planted in external content persisted into later sessions | Never store lessons from external content |

### Security

| Paper | Finding | Effect on LeanLoop |
|---|---|---|
| [2607.20759](https://arxiv.org/abs/2607.20759) IssueTrojanBench | Coding agents executed malicious issue instructions in 66.5% of runs, including editing CLAUDE.md and hooks; hidden and visible payloads worked equally | Do not change agent config unless asked; audit flags risky hooks |
| [2608.30686](https://arxiv.org/abs/2608.30686) Beyond the payload | "Run the tests" tasks were the riskiest; security rules alone did not lower attack success | Read what a script runs before running it; docs recommend a sandbox |
| [2406.13352](https://arxiv.org/abs/2406.13352) AgentDojo and [2506.08837](https://arxiv.org/abs/2506.08837) Design patterns | Restricting tools cut attack success sharply; untrusted input should not trigger consequential actions | Read-only reviewer; untrusted content treated as data |
| [2406.10279](https://arxiv.org/abs/2406.10279) Package hallucinations | Models invent package names at measurable rates | Never install packages named only in untrusted text |
| [2601.10338](https://arxiv.org/abs/2601.10338) Agent skills in the wild | 26.1% of marketplace skills had a vulnerability; bundled scripts raised the odds | LeanLoop ships no hooks or MCP servers; validation pins the layout |
| [2603.00164](https://arxiv.org/abs/2603.00164) Reverse CAPTCHA | Invisible Unicode instructions were followed more often when tools were available | Audit and validation flag invisible and bidirectional characters |

### Practice and evaluation

| Paper | Finding | Effect on LeanLoop |
|---|---|---|
| [2605.18583](https://arxiv.org/abs/2605.18583) Overeager coding agents | Removing an explicit scope statement raised out-of-scope actions from 0% to 17.1% in Claude Code | `start --scope` and "do not touch outside the scope" |
| [2507.09089](https://arxiv.org/abs/2507.09089) METR RCT | Experienced developers were 19% slower with early-2025 AI while believing they were 20% faster | Measure with timed logs, never impressions |
| [2602.07150](https://arxiv.org/abs/2602.07150) Randomness in agentic evals | Single-run scores shift by 2.2-6.0 points between runs | Repeated trials, pass@k and pass^k |
| [2411.00640](https://arxiv.org/abs/2411.00640) Error bars | Use task-clustered and paired standard errors | Paired comparison in `compare-runs` |
| [2406.12045](https://arxiv.org/abs/2406.12045) tau-bench | pass^k measures reliability across trials | Same |
| [2407.01502](https://arxiv.org/abs/2407.01502) AI agents that matter | Report cost and accuracy together; use holdouts | Evaluation procedure |

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
