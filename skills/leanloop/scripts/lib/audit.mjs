import fs from 'node:fs';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { optionalStat, readOptionalText, requireThat, safePath } from './io.mjs';
import { projectEnvironment } from './git.mjs';

const KIB = 1024;
const MAX_READ_BYTES = 1024 * KIB;
const MAX_PATHS = 300000;
const MAX_LISTED = 10;
const MAX_HANDOFF_STEPS = 200000;
const MAX_READ_TOTAL = 8 * 1024 * KIB;
const MAX_CUSTOMIZATIONS = 2000;
export const AUDIT_BYTES = 16 * KIB;

// Potential root instructions across hosts, not one host's effective prompt.
const ALWAYS_ON = ['.github/copilot-instructions.md', 'AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md'];
const SCOPED_GUIDES = /(^|\/)(AGENTS|CLAUDE|GEMINI)\.md$/;
const AGENT_DIRS = [
  ['.github/agents', /^(?!readme\.md$).+\.md$/i], ['.github/chatmodes', /\.chatmode\.md$/],
  ['.claude/agents', /^(?!readme\.md$).+\.md$/i], ['.gemini/agents', /^(?!readme\.md$).+\.md$/i],
];
const SKILL_DIRS = ['.github/skills', '.claude/skills', '.agents/skills', '.codex/skills', '.gemini/skills', '.cursor/skills'];
const HOOK_FILES = ['.claude/settings.json', '.claude/settings.local.json', '.gemini/settings.json', '.codex/hooks.json'];
const MCP_FILES = [['.vscode/mcp.json', 'servers'], ['.mcp.json', 'mcpServers'], ['.cursor/mcp.json', 'mcpServers'], ['.gemini/settings.json', 'mcpServers']];
const DISPATCH_TOOLS = new Set(['task', 'agent', 'agents', 'runsubagent', 'subagent']);
const MEMORY_PATH = /(^|\/)(learnings?|lessons?|memor(y|ies)|ledgers?|journals?)\/[^/]+\.(md|markdown|txt|jsonl?|log)$/i;
const MEMORY_NAME = /(^|\/)[^/]*(learnings?|lessons?|memor(y|ies)|ledger|journal|session-?log)[^/]*\.(md|markdown|txt|jsonl?|log)$/i;
const REFERENCE = /(?:^|[\s`'"(\[])((?:\.\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:md|markdown|txt|jsonl?|log|ya?ml))(?=$|[\s`'")\],:;])/gm;
const MAX_GUIDES = 5000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', 'dist', 'build', 'coverage', '.leanloop']);

function inspectProject(root) {
  const skipped = [];
  const seen = new Set();
  const cache = new Map();
  let bytesRead = 0;
  const issue = (file, code, reason) => {
    const key = `${file}\0${code}`;
    if (seen.has(key)) return;
    seen.add(key);
    skipped.push({ path: file, code, reason });
  };
  const failed = (file, error) => issue(file, error.code ?? 'READ_FAILED',
    `Could not inspect this path (${error.code ?? 'READ_FAILED'}); check its type, permissions, and symlinks.`);
  const stat = relative => {
    try {
      return optionalStat(root, relative);
    } catch (error) {
      failed(relative, error);
      return null;
    }
  };
  const file = relative => {
    const stats = stat(relative);
    if (stats && !stats.isFile()) {
      issue(relative, 'NOT_FILE', 'Expected a regular file; not read.');
      return null;
    }
    return stats;
  };
  const read = relative => {
    if (cache.has(relative)) return cache.get(relative);
    const stats = file(relative);
    if (!stats) {
      cache.set(relative, null);
      return null;
    }
    const result = { bytes: stats.size, text: null };
    cache.set(relative, result);
    if (stats.size > MAX_READ_BYTES || bytesRead + stats.size > MAX_READ_TOTAL) {
      issue(relative, 'READ_LIMIT', 'Exceeded the 1 MiB per-file or 8 MiB total read budget; counted but not parsed.');
      return result;
    }
    try {
      result.text = readOptionalText(root, relative, MAX_READ_BYTES);
      if (result.text === null) issue(relative, 'SOURCE_CHANGED', 'File disappeared during inspection.');
      else bytesRead += Buffer.byteLength(result.text);
    } catch (error) {
      failed(relative, error);
    }
    return result;
  };
  const list = (relative, pattern, directories = false) => {
    const stats = stat(relative);
    if (!stats) return [];
    if (!stats.isDirectory()) {
      issue(relative, 'NOT_DIRECTORY', 'Expected a customization directory.');
      return [];
    }
    try {
      const entries = fs.readdirSync(safePath(root, relative), { withFileTypes: true })
        .filter(entry => pattern.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
      if (entries.length > MAX_CUSTOMIZATIONS) issue(relative, 'PATH_LIMIT', 'Customization directory exceeds 2,000 entries.');
      return entries.slice(0, MAX_CUSTOMIZATIONS).filter(entry => {
        if (entry.isSymbolicLink()) issue(`${relative}/${entry.name}`, 'SYMLINK', 'Symlink not followed.');
        return directories ? entry.isDirectory() : entry.isFile();
      }).map(entry => `${relative}/${entry.name}`);
    } catch (error) {
      failed(relative, error);
      return [];
    }
  };
  return { read, file, list, issue, skipped };
}

export function frontmatter(text) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const fields = Object.create(null);
  if (!match) return { fields, body: text };
  let current = null;
  for (const line of match[1].split(/\r?\n/)) {
    const top = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (top) {
      current = top[1];
      fields[current] = top[2].trim();
    } else if (current && /^\s+\S/.test(line)) {
      fields[current] += `\n${line}`;
    }
  }
  return { fields, body: text.slice(match[0].length) };
}

const unquote = value => (value ?? '').trim().replace(/^['"]|['"]$/g, '');
const short = (value, limit = 80) => (value.length > limit ? `${value.slice(0, limit - 20)}...${value.slice(-17)}` : value);
const named = (items, limit = 5) => `${items.slice(0, limit).join(', ')}${items.length > limit ? `, and ${items.length - limit} more` : ''}`;
const kib = bytes => Math.round(bytes / KIB * 10) / 10;
const largest = (items, count = MAX_LISTED) => [...items].sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1)).slice(0, count);

function inventory(root, issue) {
  const { env } = projectEnvironment();
  env.GIT_OPTIONAL_LOCKS = '0';
  const git = args => execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
    env, maxBuffer: 64 * 1024 * KIB, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let top = null;
  try {
    top = git(['rev-parse', '--show-toplevel']).toString('utf8').trim();
  } catch (error) {
    if (!(error.status === 128 && /not a git repository/i.test(error.stderr?.toString() ?? ''))) {
      issue('.', 'GIT_FAILED', `Git discovery failed (${error.code ?? error.status}); inventory unavailable.`);
      return { source: 'unavailable', files: [], truncated: true };
    }
  }
  if (top && fs.realpathSync(top) === root) {
    try {
      const output = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
      requireThat(isUtf8(output), 'Non-UTF-8 paths are not supported.', 'UNSUPPORTED_PATH');
      const files = [...new Set(output.toString('utf8').split('\0').filter(Boolean))]
        .filter(file => !file.startsWith('.leanloop/'));
      return { source: 'git', files: files.slice(0, MAX_PATHS), truncated: files.length > MAX_PATHS };
    } catch (error) {
      issue('.', 'GIT_FAILED', `Git inventory failed (${error.code ?? error.status}); no filesystem fallback was used.`);
      return { source: 'unavailable', files: [], truncated: true };
    }
  }
  const files = [];
  const pending = [''];
  let visited = 0;
  let truncated = false;
  while (pending.length && !truncated) {
    const relative = pending.pop();
    let directory;
    try {
      directory = fs.opendirSync(relative ? safePath(root, relative) : root);
      for (let entry; (entry = directory.readSync());) {
        if (++visited > MAX_PATHS) {
          truncated = true;
          break;
        }
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) pending.push(child);
        else if (entry.isFile()) files.push(child);
      }
    } catch (error) {
      issue(relative || '.', error.code ?? 'READ_FAILED', 'Directory could not be inventoried.');
    } finally {
      directory?.closeSync();
    }
  }
  return { source: 'filesystem', files, truncated };
}

function longestChain(graph) {
  let steps = 0;
  let best = 0;
  for (const root of graph.keys()) {
    const seen = new Set([root]);
    const stack = [{ name: root, edges: (graph.get(root) ?? [])[Symbol.iterator]() }];
    while (stack.length) {
      if (++steps > MAX_HANDOFF_STEPS) return { length: best, exact: false };
      best = Math.max(best, seen.size);
      if (best === graph.size) return { length: best, exact: true };
      const next = stack.at(-1).edges.next();
      if (next.done) {
        seen.delete(stack.pop().name);
      } else if (!seen.has(next.value) && graph.has(next.value)) {
        seen.add(next.value);
        stack.push({ name: next.value, edges: graph.get(next.value)[Symbol.iterator]() });
      }
    }
  }
  return { length: best, exact: true };
}

function hookEntries(json) {
  const result = [];
  const events = json.hooks === undefined ? {} : json.hooks;
  requireThat(events && typeof events === 'object' && !Array.isArray(events), 'hooks must be an object.');
  for (const [event, entries] of Object.entries(events)) {
    requireThat(Array.isArray(entries), 'Hook events must contain arrays.');
    for (const entry of entries) {
      requireThat(entry && typeof entry === 'object' && !Array.isArray(entry), 'Invalid hook entry.');
      const children = entry.hooks ?? [entry];
      requireThat(Array.isArray(children), 'Nested hooks must be an array.');
      const commands = children.filter(child => child && (typeof child.command === 'string' ||
        typeof child.bash === 'string' || typeof child.powershell === 'string')).length;
      requireThat(commands === children.length, 'Unsupported hook type; only command hooks are counted.');
      requireThat(entry.matcher === undefined || typeof entry.matcher === 'string', 'Hook matcher must be a string.');
      const matcher = typeof entry.matcher === 'string' ? entry.matcher.trim() : '';
      const everyTool = ['pretooluse', 'posttooluse', 'beforetool', 'aftertool'].includes(event.toLowerCase()) &&
        ['', '*', '.*', '.+', '^.*$'].includes(matcher);
      result.push({ event, commands, everyTool });
    }
  }
  return result;
}

export function audit(root) {
  const { read, file: stat, list, issue, skipped } = inspectProject(root);
  const settings = new Map();
  const jsonFor = file => {
    if (settings.has(file)) return settings.get(file);
    const content = read(file);
    let value = null;
    if (content && content.text !== null) {
      try {
        value = JSON.parse(content.text);
        requireThat(value && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object.');
      } catch (error) {
        if (!(error instanceof SyntaxError) && error.code !== 'INVALID_INPUT') throw error;
        issue(file, 'INVALID_JSON', 'Expected a JSON object; malformed data or JSONC is not interpreted.');
        value = null;
      }
    }
    settings.set(file, value);
    return value;
  };
  const findings = [];
  const add = (severity, code, message, fix) => findings.push({ severity, code, message, fix });

  const instructionFiles = [];
  const alwaysOn = [];
  for (const file of ALWAYS_ON) {
    const content = read(file);
    if (content) {
      alwaysOn.push({ path: file, bytes: content.bytes });
      if (content.text !== null) instructionFiles.push({ path: file, text: content.text });
    }
  }
  const scoped = [];
  for (const file of list('.github/instructions', /\.instructions\.md$/)) {
    const content = read(file);
    if (!content || content.text === null) continue;
    instructionFiles.push({ path: file, text: content.text });
    const applyTo = unquote(frontmatter(content.text).fields.applyTo);
    if (['**', '**/*', '*', '**/**'].includes(applyTo)) alwaysOn.push({ path: file, bytes: content.bytes });
    else scoped.push({ path: file, bytes: content.bytes });
  }
  for (const file of list('.cursor/rules', /\.mdc?$/)) {
    const content = read(file);
    if (!content || content.text === null) continue;
    instructionFiles.push({ path: file, text: content.text });
    if (/^true$/i.test(unquote(frontmatter(content.text).fields.alwaysApply))) alwaysOn.push({ path: file, bytes: content.bytes });
    else scoped.push({ path: file, bytes: content.bytes });
  }

  const agents = [];
  for (const [directory, pattern] of AGENT_DIRS) {
    for (const file of list(directory, pattern)) {
      const content = read(file);
      if (!content || content.text === null) continue;
      instructionFiles.push({ path: file, text: content.text });
      const { fields } = frontmatter(content.text);
      const name = unquote(fields.name) || path.posix.basename(file).replace(/(\.agent|\.chatmode)?\.md$/, '');
      const tools = (fields.tools ?? '').match(/[\w./-]+/g) ?? [];
      const handoffs = [...(fields.handoffs ?? '').matchAll(/agent:\s*['"]?([\w.-]+)/g)].map(match => match[1]);
      agents.push({
        path: file, bytes: content.bytes, name, model: unquote(fields.model) || null, directory,
        dispatcher: tools.some(tool => DISPATCH_TOOLS.has(tool.split('/').at(-1).toLowerCase())), handoffs,
      });
    }
  }

  const skills = [];
  for (const directory of SKILL_DIRS) {
    for (const folder of list(directory, /./, true)) {
      const content = read(`${folder}/SKILL.md`);
      if (!content || content.text === null) continue;
      const { fields } = frontmatter(content.text);
      skills.push({
        path: `${folder}/SKILL.md`, bytes: content.bytes, descriptionBytes: Buffer.byteLength(unquote(fields.description)),
        modelInvocable: !/^true$/i.test(unquote(fields['disable-model-invocation'])),
      });
    }
  }

  const hooks = [];
  const hookFiles = [...list('.github/hooks', /\.json$/), ...HOOK_FILES];
  for (const file of hookFiles) {
    const json = jsonFor(file);
    if (!json) continue;
    try {
      for (const entry of hookEntries(json)) hooks.push({ path: file, ...entry });
    } catch (error) {
      if (error.code !== 'INVALID_INPUT') throw error;
      issue(file, 'INVALID_HOOKS', error.message);
    }
  }

  let mcpServers = 0;
  for (const [file, key] of MCP_FILES) {
    const servers = jsonFor(file)?.[key];
    if (servers === undefined) continue;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) mcpServers += Object.keys(servers).length;
    else issue(file, 'INVALID_MCP', 'Server configuration must be an object.');
  }
  const codexConfig = read('.codex/config.toml');
  if (codexConfig?.text) mcpServers += (codexConfig.text.match(/^\s*\[mcp_servers\.[^\]]+\]/gm) ?? []).length;

  const { files, source, truncated } = inventory(root, issue);
  const nestedGuides = files.filter(file => SCOPED_GUIDES.test(file) && !ALWAYS_ON.includes(file));
  for (const file of nestedGuides.slice(0, MAX_GUIDES)) {
    const stats = stat(file);
    if (stats) scoped.push({ path: file, bytes: stats.size });
  }
  const memory = [];
  for (const file of files) {
    if (!MEMORY_PATH.test(file) && !MEMORY_NAME.test(file)) continue;
    const stats = stat(file);
    if (stats) memory.push({ path: file, bytes: stats.size });
  }

  const referenced = new Map();
  for (const { path: from, text } of instructionFiles) {
    for (const match of text.matchAll(REFERENCE)) {
      const target = match[1].replace(/^\.\//, '');
      if (referenced.has(target) || target.split('/').includes('..')) continue;
      const stats = stat(target);
      if (stats && stats.size > 32 * KIB) referenced.set(target, { path: target, bytes: stats.size, referencedBy: from });
    }
  }

  const alwaysOnBytes = alwaysOn.reduce((sum, file) => sum + file.bytes, 0);
  if (alwaysOnBytes > 8 * KIB) {
    add(alwaysOnBytes > 16 * KIB ? 'high' : 'medium', 'ALWAYS_ON_LARGE',
      `${kib(alwaysOnBytes)} KiB of potential root instructions across detected hosts (rough estimate: ${Math.ceil(alwaysOnBytes / 4)} tokens). Actual loading and caching are host-dependent.`,
      'Keep always-on text to build/test commands, layout, and hard rules (target 8 KiB or less). Move procedures into on-demand skills or path-scoped instructions.');
  }
  const graph = new Map();
  for (const agent of agents) {
    const key = `${agent.directory}/${agent.name}`;
    if (graph.has(key)) issue(agent.path, 'DUPLICATE_AGENT', 'Duplicate agent name in the same discovery directory.');
    graph.set(key, agent.handoffs.map(next => `${agent.directory}/${next}`));
  }
  const chain = longestChain(graph);
  const withHandoffs = agents.filter(agent => agent.handoffs.length).length;
  if (agents.length >= 3 && chain.length >= 3) {
    add(chain.length >= 4 ? 'high' : 'medium', 'ROLE_CHAIN',
      `${agents.length} custom agents; the declared handoff graph contains a path through ${chain.length}${chain.exact ? '' : '+'} agents. This is not an observed execution trace.`,
      'Give one owner agent the whole task. Keep a separate agent only for an independent review or a separable read-only question.');
  } else if (agents.length > 4) {
    add('medium', 'MANY_AGENTS', `${agents.length} custom agents.`,
      'Check whether roles cause repeated handoffs. Keep useful specialists; prefer on-demand skills for phases that share context.');
  }
  const dispatchers = agents.filter(agent => agent.dispatcher);
  if (dispatchers.length && agents.length >= 3) {
    add('medium', 'ROUTER_AGENT', `${named(dispatchers.map(agent => agent.model ? `${short(agent.name)} (${short(agent.model)})` : short(agent.name)))} declare delegation tools; this does not establish that they only route.`,
      'Inspect actual handoffs. Keep an owner capable of implementing the task rather than requiring a routing-only agent.');
  }
  const models = new Map();
  for (const agent of agents) if (agent.model) models.set(agent.model, (models.get(agent.model) ?? 0) + 1);
  const ranked = [...models].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1));
  const pinned = Object.create(null);
  for (const [index, [model, count]] of ranked.slice(0, MAX_LISTED).entries()) {
    let label = short(model);
    while (Object.hasOwn(pinned, label) || label === '(other models)') label += ` [${index + 1}]`;
    pinned[label] = count;
  }
  if (ranked.length > MAX_LISTED) pinned['(other models)'] = ranked.slice(MAX_LISTED).reduce((sum, [, count]) => sum + count, 0);
  const pinnedCount = ranked.reduce((sum, [, count]) => sum + count, 0);
  if (pinnedCount) {
    add('low', 'PINNED_MODELS', `${pinnedCount} agent(s) declare a model: ${named(ranked.map(([model, count]) => `${short(model)} x${count}`))}.`,
      'Check that model choices are deliberate and measured. Inherit the session model unless a task needs a different capability or cost profile.');
  }
  const perTool = hooks.filter(hook => hook.everyTool).reduce((sum, hook) => sum + hook.commands, 0);
  if (perTool) {
    add(perTool >= 5 ? 'high' : 'medium', 'PER_TOOL_HOOKS',
      `${perTool} command hooks have broad tool-event matchers (${named([...new Set(hooks.filter(hook => hook.everyTool).map(hook => short(hook.path)))], 4)}); runtime activation was not measured.`,
      'Preserve authorization, secret protection, and destructive-action guards. Measure hook timing; narrow or combine only redundant bookkeeping after checking equivalent protection.');
  }
  const memoryBytes = memory.reduce((sum, file) => sum + file.bytes, 0);
  if (memoryBytes > 32 * KIB) {
    const [top] = largest(memory, 1);
    add(memoryBytes > 128 * KIB ? 'high' : 'medium', 'MEMORY_UNBOUNDED',
      `${memory.length} memory-like files total ${kib(memoryBytes)} KiB; largest ${short(top.path, 180)} (${kib(top.bytes)} KiB). Their presence does not prove they are all loaded.`,
      'Keep frequently loaded memory small and evidence-backed; retain larger reference material for targeted retrieval rather than deleting it or reading whole logs.');
  }
  const referencedFiles = largest(referenced.values());
  if (referencedFiles.length) {
    add(referencedFiles[0].bytes > 128 * KIB ? 'high' : 'medium', 'LARGE_REFERENCED_FILES',
      `Instructions mention ${referenced.size} file(s) over 32 KiB; largest ${short(referencedFiles[0].path, 180)} (${kib(referencedFiles[0].bytes)} KiB). A mention is not proof of a full read.`,
      'Point agents at a short summary or a specific section instead of whole reports, ledgers, or logs.');
  }
  if (mcpServers > 8) {
    add('low', 'MANY_MCP_SERVERS', `${mcpServers} MCP servers are configured.`,
      'Check the host trace before changing servers: tool discovery may be deferred. Remove only unused integrations, not required controls.');
  }

  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((left, right) => order[left.severity] - order[right.severity]);
  const counts = Object.fromEntries(['high', 'medium', 'low'].map(level => [level, findings.filter(item => item.severity === level).length]));
  const complete = skipped.length === 0 && !truncated && nestedGuides.length <= MAX_GUIDES && chain.exact;
  const report = {
    ok: complete && counts.high === 0, complete,
    project: root,
    summary: `${counts.high} high, ${counts.medium} medium, ${counts.low} low`,
    alwaysOn: { bytes: alwaysOnBytes, approxTokens: Math.ceil(alwaysOnBytes / 4), files: largest(alwaysOn) },
    scopedInstructions: {
      count: scoped.length, bytes: scoped.reduce((sum, file) => sum + file.bytes, 0), largest: largest(scoped, 5),
      nestedGuides: nestedGuides.length, truncated: nestedGuides.length > MAX_GUIDES,
    },
    agents: {
      count: agents.length, bytes: agents.reduce((sum, agent) => sum + agent.bytes, 0), withHandoffs,
      longestHandoffChain: chain.length, chainExact: chain.exact,
      dispatcherCount: dispatchers.length, dispatchers: dispatchers.slice(0, MAX_LISTED).map(agent => short(agent.name)),
      pinnedModels: pinned, pinnedModelCount: ranked.length, pinnedAgentCount: pinnedCount,
      largest: largest(agents.map(({ path: file, bytes }) => ({ path: file, bytes })), 5),
    },
    skills: {
      count: skills.length, modelInvocable: skills.filter(skill => skill.modelInvocable).length,
      descriptionBytes: skills.reduce((sum, skill) => sum + skill.descriptionBytes, 0), bodyBytes: skills.reduce((sum, skill) => sum + skill.bytes, 0),
    },
    hooks: { commands: hooks.reduce((sum, hook) => sum + hook.commands, 0), everyToolCall: perTool, files: [...new Set(hooks.map(hook => hook.path))].slice(0, MAX_LISTED) },
    mcpServers,
    memory: { files: memory.length, bytes: memoryBytes, largest: largest(memory, 5) },
    referencedLargeFiles: referencedFiles,
    findings,
    inventory: { source, paths: files.length, truncated },
    skipped: skipped.slice(0, MAX_LISTED),
    skippedCount: skipped.length,
    output: { maxBytes: AUDIT_BYTES, truncated: false },
    note: 'Read-only on-disk inventory, not observed prompt tokens, cost, hook timing, or proof of loaded context. User-level and inherited host settings are not inspected. Bytes/4 and severity thresholds are heuristics.',
  };
  const details = [report.alwaysOn.files, report.scopedInstructions.largest, report.agents.largest,
    report.agents.dispatchers, report.hooks.files, report.memory.largest, report.referencedLargeFiles, report.skipped];
  const size = () => Buffer.byteLength(`${JSON.stringify(report)}\n`);
  while (size() > AUDIT_BYTES) {
    const largestDetail = details.filter(items => items.length).sort((a, b) =>
      Buffer.byteLength(JSON.stringify(b)) - Buffer.byteLength(JSON.stringify(a)))[0];
    requireThat(largestDetail, 'Audit summary exceeds its output budget.', 'OUTPUT_LIMIT');
    largestDetail.pop();
    report.output.truncated = true;
  }
  return report;
}
