# Sources and provenance

Reviewed on 2026-10-20 (0.1.0) and reassessed for 0.2.0 and 0.3.0 the same day.
Version 0.4.0 renamed the project from lean-workflow to LeanLoop. This
implementation, its prompts, and its tests were written independently. No
third-party runtime code or skill text is vendored. The MIT license covers this
package's original files; source references do not relicense upstream work or
determine rights outside this package.

## Public repositories and engineering guidance

LeanLoop is based on the first two projects below. The others informed specific
design choices.

| Source | What informed this package | What was not assumed |
|---|---|---|
| [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd/tree/1ecea1993b7fce257ffbd686c070948b5e07eda6), MIT (still HEAD on 2026-10-20) | Actionable presentation: outcome first, numbered steps, restated state, one next action, capped visible lists; one skill shipped to many hosts | It is an output-style skill, not a faster coding engine; no diagnosis, clinical generalizations, forced causes, or mandatory time estimates were adopted |
| [WorldFlowAI/everything-claude-code](https://github.com/worldflowai/everything-claude-code), which builds on [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) (MIT; now served as `affaan-m/ECC`); local historical snapshot reviewed at `432485b` | Reusable skills and explicit verification workflows; its verify, checkpoint, and learn workflows became bounded CLI commands (`check`, `checkpoint`, `learn`) | No automatic-memory claims, blanket model policies, broad hooks, or unverified cross-host compatibility. The WorldFlowAI copy's README states MIT but it has no root LICENSE file on 2026-10-20; no text from it was reused |
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

## Runtime and format references

- [Agent Skills specification](https://agentskills.io/specification): `name`
  (matches the folder), `description` (at most 1,024 characters), optional
  `license`, progressive disclosure.
- [VS Code agent skills](https://code.visualstudio.com/docs/agent-customization/agent-skills):
  project skills in `.github/skills/`, `.claude/skills/`, or `.agents/skills/`;
  Codex discovers `.agents/skills/` natively.
- [GitHub Copilot agent skills](https://docs.github.com/en/copilot/concepts/customizations/agent-skills):
  the same three project locations for the Copilot app, CLI, cloud agent, and IDEs.
- [Gemini CLI agent skills](https://geminicli.com/docs/cli/skills/):
  workspace skills in `.gemini/skills/` or the `.agents/skills/` alias.
- [Claude Code skills](https://code.claude.com/docs/en/skills) and
  [subagents](https://code.claude.com/docs/en/sub-agents): `.claude/skills/`,
  `.claude/agents/`, read-only built-in exploration agents.
- [VS Code customization migration](https://code.visualstudio.com/docs/agent-customization/migrate-customizations):
  Copilot harness skills versus Local prompt files and location settings.
- [Copilot custom-agent configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration):
  inherited model choice and read/search tool aliases.
- [VS Code agent plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins):
  plugin discovery is distinct from runtime compatibility.
- [Node child processes](https://nodejs.org/api/child_process.html):
  argument arrays, process creation, and signal behavior.
- [Git diff](https://git-scm.com/docs/git-diff) and
  [Git ls-files](https://git-scm.com/docs/git-ls-files):
  repository-visible changes and path inventories.

## What remains to establish

Automated local tests establish specific implementation behaviors, not general
engineering capability. A real cost/latency comparison requires controlled runs
on representative projects, provider-reported usage, and acceptance outcomes.
See the [evaluation procedure](docs/evaluation.md). No paid provider comparison
or assertion of defect-free behavior is included.
