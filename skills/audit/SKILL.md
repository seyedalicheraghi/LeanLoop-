---
name: audit
description: "Audit this project's Claude Code setup for overhead and risky configuration: always-on instructions and imports, rules, agents, hooks, permissions, MCP servers, and hidden Unicode. Read-only."
disable-model-invocation: true
license: MIT
---

# LeanLoop audit

Run `node "${CLAUDE_PLUGIN_ROOT}/leanloop.mjs" audit` from the project root. It
is read-only, never follows symlinks, and works without `/leanloop:setup`. It
covers CLAUDE.md, `.claude/CLAUDE.md`, and CLAUDE.local.md in the project and
its parent folders, and AGENTS.md files, which Claude Code reads by default
only when none of those exists on the path; it reports AGENTS.md files that
are shadowed and not imported.

Relay its JSON; do not rescore it or claim more than it shows:

- Lead with high-severity findings and whether `complete` is true. An
  incomplete audit is not a clean bill of health.
- Findings are structural indicators, not measured token use, cost, or proof
  of malicious content.
- For each finding give the file, why it matters, and the smallest change the
  user could choose. Size findings are recurring context cost, not quality:
  keep rules that prevent real mistakes.
- Do not edit configuration yourself. Keep hooks and permission rules that
  protect secrets or block destructive actions.
