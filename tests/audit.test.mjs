import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { audit, frontmatter } from '../skills/leanloop/scripts/lib/audit.mjs';
import { temporary, git, cli, cliPath } from './helpers.mjs';

function write(root, relative, content) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content);
}

function snapshot(root) {
  const entries = [];
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.name === '.git') continue;
      const stats = fs.lstatSync(path.join(root, child));
      entries.push(`${child}:${stats.size}:${stats.mtimeMs}`);
      if (entry.isDirectory()) walk(child);
    }
  };
  walk('');
  return entries.sort();
}

function roleChainProject(t) {
  const root = temporary(t);
  git(root, ['init', '--initial-branch=main']);
  write(root, '.github/copilot-instructions.md', `# Rules\nRead \`docs/learnings/router.md\` before work.\n${'Always do this.\n'.repeat(1300)}`);
  const roles = ['router', 'planner', 'coder', 'tester', 'reporter'];
  roles.forEach((role, index) => {
    const next = roles[index + 1];
    const tools = role === 'router' ? "['task', 'editFiles']" : "['search', 'editFiles']";
    write(root, `.github/agents/${role}.agent.md`, [
      '---', `name: ${role}`, `description: The ${role}.`, `tools: ${tools}`, 'model: premium-model-x',
      ...(next ? ['handoffs:', `  - label: Next`, `    agent: ${next}`] : []), '---', `You are the ${role}.`, '',
    ].join('\n'));
  });
  write(root, '.github/hooks/guards.json', JSON.stringify({
    hooks: {
      sessionStart: [{ command: 'python3 start.py' }],
      preToolUse: Array.from({ length: 6 }, (_, index) => ({ matcher: '.*', command: `python3 guard${index}.py` })),
    },
  }));
  write(root, 'docs/learnings/router.md', `# Router learnings\n${'- lesson that never expires\n'.repeat(6000)}`);
  write(root, '.vscode/mcp.json', JSON.stringify({ servers: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, {}])) }));
  return root;
}

test('audit measures the overhead of a role-chain setup and names a fix for each finding', t => {
  const root = roleChainProject(t);
  const before = snapshot(root);
  const result = cli(root, ['audit']);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(snapshot(root), before, 'audit must not write anything');
  assert.ok(Buffer.byteLength(result.stdout) < 8192, 'audit output stays bounded');
  const report = JSON.parse(result.stdout);
  const codes = Object.fromEntries(report.findings.map(item => [item.code, item.severity]));
  assert.equal(report.ok, false);
  assert.equal(codes.ALWAYS_ON_LARGE, 'high');
  assert.equal(codes.ROLE_CHAIN, 'high');
  assert.equal(codes.PER_TOOL_HOOKS, 'high');
  assert.equal(codes.MEMORY_UNBOUNDED, 'high');
  assert.equal(codes.LARGE_REFERENCED_FILES, 'high');
  assert.equal(codes.ROUTER_AGENT, 'medium');
  assert.equal(codes.PINNED_MODELS, 'low');
  assert.equal(codes.MANY_MCP_SERVERS, 'low');
  assert.equal(report.agents.longestHandoffChain, 5);
  assert.deepEqual(report.agents.dispatchers, ['router']);
  assert.equal(report.hooks.everyToolCall, 6);
  assert.ok(report.findings.every(item => item.fix && item.message));
  assert.equal(report.findings[0].severity, 'high');
});

test('a lean setup passes the audit without a Git repository or leanloop configuration', t => {
  const root = temporary(t);
  write(root, 'AGENTS.md', '# Project\nBuild: `npm run build`. Test: `npm test`.\n');
  write(root, '.github/skills/fix/SKILL.md', '---\nname: fix\ndescription: Fix a bug.\n---\nSteps.\n');
  write(root, '.github/agents/reviewer.agent.md', '---\nname: reviewer\ntools: ["read", "search"]\n---\nReview.\n');
  const report = audit(fs.realpathSync(root));
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.inventory.source, 'filesystem');
  assert.equal(report.skills.count, 1);
  assert.equal(report.skills.modelInvocable, 1);
  const result = cli(root, ['audit']);
  assert.equal(result.status, 0, result.stderr);
});

test('audit does not follow symlinks and tolerates malformed hook files', t => {
  const root = temporary(t);
  const outside = temporary(t);
  write(outside, 'huge.md', 'x'.repeat(64 * 1024));
  fs.mkdirSync(path.join(root, '.github/hooks'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'huge.md'), path.join(root, '.github/copilot-instructions.md'));
  write(root, '.github/hooks/broken.json', '{not json');
  write(root, '.claude/settings.json', JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'check-bash' }] },
        { hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] },
      ],
    },
  }));
  const report = audit(fs.realpathSync(root));
  assert.equal(report.alwaysOn.bytes, 0);
  assert.deepEqual(report.skipped.map(item => item.path), ['.github/copilot-instructions.md', '.github/hooks/broken.json']);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.equal(report.hooks.commands, 3);
  assert.equal(report.hooks.everyToolCall, 2);
  assert.ok(report.findings.some(item => item.code === 'PER_TOOL_HOOKS' && item.severity === 'medium'));
  assert.match(report.findings.find(item => item.code === 'PER_TOOL_HOOKS').fix, /Preserve authorization/);
});

test('instruction files apply only when their scope covers every file', t => {
  const root = temporary(t);
  write(root, '.github/instructions/all.instructions.md', `---\napplyTo: '**'\n---\n${'a'.repeat(9000)}`);
  write(root, '.github/instructions/py.instructions.md', `---\napplyTo: '**/*.py'\n---\n${'b'.repeat(9000)}`);
  const report = audit(fs.realpathSync(root));
  assert.deepEqual(report.alwaysOn.files.map(file => file.path), ['.github/instructions/all.instructions.md']);
  assert.equal(report.scopedInstructions.count, 1);
  assert.ok(report.findings.some(item => item.code === 'ALWAYS_ON_LARGE' && item.severity === 'medium'));
});

test('frontmatter parsing keeps nested handoff blocks and ignores bodies', () => {
  const { fields, body } = frontmatter('---\nname: a\nhandoffs:\n  - label: Go\n    agent: b\n---\nmodel: not-frontmatter\n');
  assert.equal(fields.name, 'a');
  assert.match(fields.handoffs, /agent: b/);
  assert.equal(fields.model, undefined);
  assert.equal(body, 'model: not-frontmatter\n');
});

test('audit output stays bounded with many agents and huge model names', t => {
  const root = temporary(t);
  for (let index = 0; index < 50; index += 1) {
    write(root, `.github/agents/a${index}.agent.md`,
      `---\nname: ${'agent-name-'.repeat(50)}${index}\ntools: ['task']\nmodel: ${'m'.repeat(5000)}${index}\n---\nBody.\n`);
  }
  const report = audit(fs.realpathSync(root));
  const bytes = Buffer.byteLength(JSON.stringify(report));
  assert.ok(bytes < 16 * 1024, `audit JSON is ${bytes} bytes`);
  assert.ok(Object.keys(report.agents.pinnedModels).length <= 11);
  assert.equal(report.agents.pinnedModels['(other models)'], 40);
  assert.equal(report.agents.dispatcherCount, 50);
  assert.equal(report.agents.dispatchers.length, 10);
  assert.ok(report.findings.every(item => item.message.length < 1200));
});

test('audit detects large top-level files that instructions point at, and counts every nested guide', t => {
  const root = temporary(t);
  write(root, 'AGENTS.md', 'Read ARCHITECTURE.md before any change.\n');
  write(root, 'ARCHITECTURE.md', 'x'.repeat(40 * 1024));
  for (let index = 0; index < 201; index += 1) write(root, `pkg${index}/AGENTS.md`, 'Local rules.\n');
  const report = audit(fs.realpathSync(root));
  assert.deepEqual(report.referencedLargeFiles.map(file => file.path), ['ARCHITECTURE.md']);
  assert.ok(report.findings.some(item => item.code === 'LARGE_REFERENCED_FILES' && item.severity === 'medium'));
  assert.equal(report.scopedInstructions.count, 201);
  assert.equal(report.scopedInstructions.nestedGuides, 201);
  assert.equal(report.scopedInstructions.truncated, false);
});

test('an incomplete audit never reports a clean success', t => {
  const root = temporary(t);
  for (const content of ['{bad', '{"hooks":{"PreToolUse":"not-an-array"}}']) {
    write(root, '.github/hooks/broken.json', content);
    const result = cli(root, ['audit']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.complete, false);
    assert.ok(report.skipped.some(item => item.path === '.github/hooks/broken.json'));
  }
});

test('audit keeps exact model identities before bounding the display', t => {
  const root = temporary(t);
  for (const [index, model] of ['constructor', '__proto__', 'toString',
    `${'m'.repeat(100)}FIRST${'z'.repeat(50)}`, `${'m'.repeat(100)}SECOND${'z'.repeat(50)}`].entries()) {
    write(root, `.github/agents/agent-${index}.md`, `---\nname: agent-${index}\nmodel: ${model}\n---\nRead only.\n`);
  }
  const report = audit(fs.realpathSync(root));
  assert.equal(report.agents.pinnedModelCount, 5);
  assert.equal(report.agents.pinnedAgentCount, 5);
  assert.ok(Object.values(report.agents.pinnedModels).every(count => Number.isSafeInteger(count)));
});

test('audit caps actual serialized output for long multibyte paths', t => {
  const root = temporary(t);
  let directory = 'docs/lessons';
  for (let i = 0; i < 14; i += 1) directory += `/${'界'.repeat(75)}`;
  for (let i = 0; i < 14; i += 1) {
    const file = `${directory}/lesson-${i}.md`;
    write(root, file, 'x'.repeat(40000));
    write(root, `.github/agents/reader-${i}.md`, `---\nname: reader-${i}\n---\nRead ${file}\n`);
  }
  const result = cli(root, ['audit']);
  const report = JSON.parse(result.stdout);
  assert.ok(Buffer.byteLength(result.stdout) <= 16 * 1024);
  assert.equal(report.output.maxBytes, 16 * 1024);
  assert.equal(report.output.truncated, true);
  assert.equal(report.memory.files, 14);
});

test('oversized customization files are disclosed rather than treated as absent', t => {
  const root = temporary(t);
  write(root, '.github/hooks/oversized.json', ' '.repeat(1024 * 1024 + 1));
  const report = audit(fs.realpathSync(root));
  assert.equal(report.ok, false);
  assert.equal(report.complete, false);
  assert.equal(report.skippedCount, 1);
  assert.equal(report.skipped[0].code, 'READ_LIMIT');
});

test('same agent names in different host folders do not create cross-host chains', t => {
  const root = temporary(t);
  write(root, '.github/agents/first.md', '---\nname: first\nhandoffs:\n  - agent: second\n---\n');
  write(root, '.github/agents/second.md', '---\nname: second\n---\n');
  write(root, '.claude/agents/second.md', '---\nname: second\nhandoffs:\n  - agent: third\n---\n');
  write(root, '.claude/agents/third.md', '---\nname: third\n---\n');
  const report = audit(fs.realpathSync(root));
  assert.equal(report.agents.longestHandoffChain, 2);
  assert.ok(!report.findings.some(item => item.code === 'ROLE_CHAIN'));
});

test('Git failures are reported rather than silently falling back to a different inventory', t => {
  const root = temporary(t);
  const emptyPath = temporary(t);
  const result = spawnSync(process.execPath, [cliPath, 'audit', '--project', root], {
    env: { ...process.env, PATH: emptyPath }, encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.complete, false);
  assert.equal(report.inventory.source, 'unavailable');
  assert.ok(report.skipped.some(item => item.code === 'GIT_FAILED'));
});
