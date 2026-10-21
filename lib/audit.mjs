import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { requireThat, safePath } from './io.mjs';
import { projectEnvironment } from './git.mjs';

const KIB = 1024;
const MAX_READ_BYTES = 1024 * KIB;
const MAX_READ_TOTAL = 8 * 1024 * KIB;
const MAX_PATHS = 300000;
const MAX_LISTED = 10;
const MAX_CUSTOMIZATIONS = 2000;
const MAX_TREE_DEPTH = 8;
const MAX_IMPORT_HOPS = 4;
const MAX_GUIDES = 5000;
const MAX_LINES = 200;
export const AUDIT_BYTES = 16 * KIB;

// Claude Code project memory loaded at launch; ancestor directories are walked separately.
const ROOT_INSTRUCTIONS = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];
const ANCESTOR_INSTRUCTIONS = ['CLAUDE.md', '.claude/CLAUDE.md'];
const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];
const NESTED_GUIDE = /(^|\/)CLAUDE(\.local)?\.md$/;
const MARKDOWN = /\.md$/i;
const AGENT_FILE = /^(?!readme\.md$).+\.md$/i;
const INSTRUCTION_KINDS = new Set(['project', 'import', 'ancestor', 'rule', 'agent', 'skill', 'command']);
const BROAD_GLOBS = new Set(['**', '**/*', '*', '**/**']);
const DISPATCH_TOOLS = new Set(['agent', 'task']);
const TOOL_EVENTS = new Set(['pretooluse', 'posttooluse']);
const BROAD_MATCHERS = new Set(['', '*', '.*', '.+', '^.*$']);
const BROAD_RULE = /^(\*|(Bash|PowerShell)(\((\*|:\*)\))?)$/;
const REMOTE_TYPES = new Set(['http', 'sse', 'ws', 'streamable-http']);
const LAUNCHERS = new Map([
  ['npx', { spec: ['-p', '--package'], value: ['-c', '--call', '--registry', '--cache'] }],
  ['uvx', { spec: ['--from'], value: ['-p', '--python', '--with', '--index', '--index-url', '--extra-index-url'] }],
  ['pipx', { spec: ['--spec'], value: ['--python', '--pip-args', '--index-url'] }],
]);
const NETWORK = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i;
const PIPED = /\|\s*(sudo\s+)?(sh|bash|zsh|dash|node|python3?|perl|ruby|pwsh|powershell)\b|\b(iex|Invoke-Expression)\b/i;
const HIDDEN = /[\u{E0000}-\u{E007F}\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/gu;
const INJECTION = [
  /\b(ignore|disregard)\s+(all\s+|any\s+)?(the\s+|your\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|prompts?|rules|directions|messages|context)\b/i,
  /\bignore\s+all\s+prior\b/i,
  /\b(do\s+not|don't|never)\s+(tell|inform|notify|alert)\s+the\s+user\b/i,
  /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|\n]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|pwsh|powershell|iex)\b/i,
];
const TEST_COMMAND = /\b((npm|pnpm|yarn|bun)\s+(run\s+)?test|pytest|cargo\s+test|go\s+test|make\s+test|gradlew?\s+test|mvnw?\s+test|dotnet\s+test|node\s+--test|vitest|jest|ctest|bazel\s+test)\b/i;
const SECRET_KEY = /token|key|secret|password|passwd|credential|^authorization$/i;
const MEMORY_PATH = /(^|\/)(learnings?|lessons?|memor(y|ies)|ledgers?|journals?)\/[^/]+\.(md|markdown|txt|jsonl?|log)$/i;
const MEMORY_NAME = /(^|\/)[^/]*(learnings?|lessons?|memor(y|ies)|ledger|journal|session-?log)[^/]*\.(md|markdown|txt|jsonl?|log)$/i;
const REFERENCE = /(?:^|[\s`'"(\[])((?:\.\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:md|markdown|txt|jsonl?|log|ya?ml))(?=$|[\s`'")\],:;])/gm;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', 'dist', 'build', 'coverage', '.leanloop']);
const NOTE = 'Read-only structural inventory of Claude Code project files and ancestor CLAUDE.md files. Findings are indicators, not ' +
  'measurements: the audit does not detect malicious content or measure real token use, cost, caching, or hook timing. User-level ' +
  'settings and MCP servers are not inspected; bytes/4 and severity thresholds are heuristics.';

// Reads at most limit + 1 bytes from a descriptor opened without following a final symlink where the OS supports it.
function readBounded(file, limit) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(Math.min(fs.fstatSync(descriptor).size, limit) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    requireThat(length < buffer.length, 'File changed during inspection.', 'SOURCE_CHANGED');
    return buffer.subarray(0, length);
  } finally {
    fs.closeSync(descriptor);
  }
}

function inspector(root) {
  const skipped = [];
  const seen = new Set();
  const cache = new Map();
  let bytesRead = 0;
  const label = (relative, base) => (base === root ? relative : path.join(base, ...relative.split('/')));
  const issue = (file, code, reason) => {
    const key = `${file}\0${code}`;
    if (seen.has(key)) return;
    seen.add(key);
    skipped.push({ path: file, code, reason });
  };
  const failed = (file, error) => issue(file, error.code ?? 'READ_FAILED',
    `Could not inspect this path (${error.code ?? 'READ_FAILED'}); check its type and permissions.`);
  // Each component is checked with lstat, so no symlink or junction is ever followed.
  const stat = (relative, base = root) => {
    const parts = relative.split('/');
    if (!parts.every(part => part && part !== '.' && part !== '..' && (process.platform !== 'win32' || !/[<>:"|?*\\]/.test(part)))) return null;
    let current = base;
    try {
      for (const [index, part] of parts.entries()) {
        current = path.join(current, part);
        const stats = fs.lstatSync(current);
        if (stats.isSymbolicLink()) {
          issue(label(parts.slice(0, index + 1).join('/'), base), 'SYMLINK', 'Symlink or junction not followed.');
          return null;
        }
        if (index === parts.length - 1) return stats;
        if (!stats.isDirectory()) return null;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') failed(label(relative, base), error);
    }
    return null;
  };
  const read = (relative, base = root, kind = 'other') => {
    const key = label(relative, base);
    if (cache.has(key)) return cache.get(key);
    let result = null;
    const stats = stat(relative, base);
    if (stats && !stats.isFile()) issue(key, 'NOT_FILE', 'Expected a regular file; not read.');
    else if (stats) {
      result = { path: key, bytes: stats.size, text: null, kind, local: base === root };
      const limited = size => size > MAX_READ_BYTES || bytesRead + size > MAX_READ_TOTAL;
      const over = () => issue(key, 'READ_LIMIT', 'Exceeded the 1 MiB per-file or 8 MiB total read budget; counted but not parsed.');
      if (limited(stats.size)) over();
      else {
        try {
          const content = readBounded(path.join(base, ...relative.split('/')), MAX_READ_BYTES);
          if (limited(content.length)) over();
          else {
            bytesRead += content.length;
            result.text = content.toString('utf8');
          }
        } catch (error) {
          if (error.code === 'ENOENT') issue(key, 'SOURCE_CHANGED', 'File disappeared during inspection.');
          else failed(key, error);
        }
      }
    }
    cache.set(key, result);
    return result;
  };
  const entries = relative => {
    const stats = stat(relative);
    if (!stats) return [];
    if (!stats.isDirectory()) {
      issue(relative, 'NOT_DIRECTORY', 'Expected a customization directory.');
      return [];
    }
    try {
      const items = fs.readdirSync(path.join(root, ...relative.split('/')), { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      if (items.length > MAX_CUSTOMIZATIONS) issue(relative, 'PATH_LIMIT', 'Customization directory exceeds 2,000 entries.');
      return items.slice(0, MAX_CUSTOMIZATIONS);
    } catch (error) {
      failed(relative, error);
      return [];
    }
  };
  const list = (relative, pattern, directories = false) => entries(relative).filter(entry => pattern.test(entry.name)).filter(entry => {
    if (entry.isSymbolicLink()) issue(`${relative}/${entry.name}`, 'SYMLINK', 'Symlink or junction not followed.');
    return directories ? entry.isDirectory() : entry.isFile();
  }).map(entry => `${relative}/${entry.name}`);
  const tree = (relative, pattern) => {
    const files = [];
    const pending = [[relative, 1]];
    let visited = 0;
    while (pending.length) {
      const [directory, depth] = pending.shift();
      for (const entry of entries(directory)) {
        const child = `${directory}/${entry.name}`;
        if (++visited > MAX_CUSTOMIZATIONS) {
          issue(relative, 'PATH_LIMIT', 'Customization tree exceeds 2,000 entries.');
          return files;
        }
        if (entry.isSymbolicLink()) issue(child, 'SYMLINK', 'Symlink or junction not followed.');
        else if (entry.isDirectory() && depth < MAX_TREE_DEPTH) pending.push([child, depth + 1]);
        else if (entry.isDirectory()) issue(child, 'DEPTH_LIMIT', `Nested more than ${MAX_TREE_DEPTH} levels; not inspected.`);
        else if (entry.isFile() && pattern.test(entry.name)) files.push(child);
      }
    }
    return files;
  };
  return { read, stat, list, tree, issue, skipped, cache };
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

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unquote = value => (value ?? '').trim().replace(/^['"]|['"]$/g, '');
const parsed = text => frontmatter((text ?? '').replace(/^\uFEFF/, ''));
const listItems = value => (value ?? '').trim().replace(/^\[|\]$/g, '').split(/,(?![^(]*\))|\n/)
  .map(item => unquote(item.replace(/^\s*-\s*/, ''))).filter(Boolean);
const lineCount = text => text.split(/\r\n|\r|\n/).length - (/[\r\n]$/.test(text) ? 1 : 0);
const short = (value, limit = 80) => (value.length > limit ? `${value.slice(0, limit - 20)}...${value.slice(-17)}` : value);
const named = (items, limit = 5) => `${items.slice(0, limit).join(', ')}${items.length > limit ? `, and ${items.length - limit} more` : ''}`;
const kib = bytes => Math.round(bytes / KIB * 10) / 10;
const total = items => items.reduce((sum, item) => sum + item.bytes, 0);
const tally = items => ({ count: items.length, bytes: total(items) });
const sized = ({ path: file, bytes }) => ({ path: file, bytes });
const largest = (items, count = MAX_LISTED) => [...items].sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1))
  .slice(0, count).map(sized);
const pinned = spec => /^([.~/\\]|[a-z]:[\\/])/i.test(spec) || /^(@[^@/\s]+\/)?[^@\s]+@v?\d[\w.+-]*$/.test(spec) || /^[^=\s]+==v?\d/.test(spec);
const looksSecret = value => {
  if (typeof value !== 'string') return false;
  const bare = value.trim().replace(/^(bearer|basic|token)\s+/i, '');
  return bare.length >= 8 && !/[\s<>]|\$\{|^\$\w+$|^%\w+%$|^(https?:\/\/|[./~]|[a-z]:[\\/])/i.test(bare) &&
    !/^(your|example|sample|placeholder|changeme|replace|redacted|dummy|none|null|x+$|\*+$)/i.test(bare);
};

// Counts npx/uvx/pipx launches whose package spec has no exact version; specs are never returned.
function unpinnedLaunches(words) {
  let count = 0;
  const tokens = words.map(word => word.replace(/^['"]+|['"]+$/g, ''));
  for (const [index, token] of tokens.entries()) {
    const name = token.split(/[\\/]/).at(-1).replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase();
    const launcher = LAUNCHERS.get(name);
    if (!launcher) continue;
    let spec = null;
    for (let next = index + 1; next < tokens.length && spec === null; next += 1) {
      const word = tokens[next];
      if (/^(&&|\|\|?|;|&)$/.test(word)) break;
      const equals = word.startsWith('-') ? word.indexOf('=') : -1;
      const option = equals > 0 ? word.slice(0, equals) : word;
      if (launcher.spec.includes(option)) spec = equals > 0 ? word.slice(equals + 1) : tokens[++next] ?? '';
      else if (launcher.value.includes(option)) next += equals > 0 ? 0 : 1;
      else if (!word.startsWith('-') && !(name === 'pipx' && word === 'run')) spec = word;
    }
    if (spec !== null && !pinned(spec)) count += 1;
  }
  return count;
}

function hookEntries(json) {
  const result = [];
  const events = json.hooks === undefined ? {} : json.hooks;
  requireThat(isObject(events), 'hooks must be an object.');
  for (const [event, entries] of Object.entries(events)) {
    requireThat(Array.isArray(entries), 'Hook events must contain arrays.');
    for (const entry of entries) {
      requireThat(isObject(entry) && Array.isArray(entry.hooks), 'Each hook entry needs a hooks array.');
      requireThat(entry.hooks.every(hook => isObject(hook) && (typeof hook.command === 'string' || typeof hook.type === 'string')),
        'Each hook needs a type or a command.');
      requireThat(entry.matcher === undefined || typeof entry.matcher === 'string', 'Hook matcher must be a string.');
      result.push({
        handlers: entry.hooks.length,
        everyTool: TOOL_EVENTS.has(event.toLowerCase()) && BROAD_MATCHERS.has((entry.matcher ?? '').trim()),
        commands: entry.hooks.filter(hook => typeof hook.command === 'string').map(hook => hook.command),
      });
    }
  }
  return result;
}

// Claude Code @path imports outside inline code and fenced blocks; trailing sentence punctuation is dropped.
function importTargets(text) {
  const targets = [];
  let fence = null;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (fence === null || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence === null ? marker : null;
      continue;
    }
    if (fence !== null) continue;
    for (const match of line.replace(/(`+).*?\1/g, ' ').matchAll(/(?:^|\s)@([^\s`]+)/g)) {
      const target = match[1].replace(/[.,;:!?)\]]+$/, '');
      if (target) targets.push(target);
    }
  }
  return targets;
}

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

export function audit(root) {
  const { read, stat, list, tree, issue, skipped, cache } = inspector(root);
  const findings = [];
  const add = (severity, code, message, advice) => findings.push({ severity, code, message, advice });
  const jsonFor = (file, kind) => {
    const content = read(file, root, kind);
    if (!content || content.text === null) return null;
    try {
      const value = JSON.parse(content.text.replace(/^\uFEFF/, ''));
      if (isObject(value)) return value;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    issue(file, 'INVALID_JSON', 'Expected a JSON object; malformed data or JSONC is not interpreted.');
    return null;
  };

  // Always-on text keyed by exact path: project memory, ancestors, their @imports, and unscoped rules.
  const alwaysOn = new Map();
  const queue = [];
  const load = (relative, base, kind, depth) => {
    const content = read(relative, base, kind);
    if (!content || alwaysOn.has(content.path)) return;
    alwaysOn.set(content.path, content);
    if (content.text !== null) queue.push({ file: path.join(base, ...relative.split('/')), text: content.text, depth });
  };
  for (const file of ROOT_INSTRUCTIONS) load(file, root, 'project', 0);
  for (let directory = root; path.dirname(directory) !== directory;) {
    directory = path.dirname(directory);
    for (const file of ANCESTOR_INSTRUCTIONS) load(file, directory, 'ancestor', 0);
  }
  const within = absolute => {
    const relative = path.relative(root, absolute);
    const parts = relative.split(path.sep);
    return relative && !path.isAbsolute(relative) && parts.every(part => part && part !== '.' && part !== '..') ? parts.join('/') : null;
  };
  const outside = new Set();
  const missing = new Set();
  const beyond = new Set();
  for (let index = 0; index < queue.length; index += 1) {
    const { file, text, depth } = queue[index];
    for (const target of importTargets(text)) {
      const absolute = target === '~' || target.startsWith('~/')
        ? path.join(os.homedir(), target.slice(2)) : path.resolve(path.dirname(file), target);
      const relative = within(absolute);
      const key = relative ?? absolute;
      if (alwaysOn.has(key)) continue;
      if (depth >= MAX_IMPORT_HOPS) beyond.add(key);
      else if (relative === null) outside.add(absolute);
      else if (stat(relative)?.isFile()) load(relative, root, 'import', depth + 1);
      else missing.add(relative);
    }
  }

  const scoped = [];
  for (const file of tree('.claude/rules', MARKDOWN)) {
    const content = read(file, root, 'rule');
    if (!content || alwaysOn.has(content.path)) continue;
    const globs = listItems(parsed(content.text).fields.paths);
    if (globs.length && !globs.every(glob => BROAD_GLOBS.has(glob))) scoped.push(content);
    else alwaysOn.set(content.path, content);
  }

  const agents = [];
  for (const file of list('.claude/agents', AGENT_FILE)) {
    const content = read(file, root, 'agent');
    if (!content) continue;
    const { fields } = parsed(content.text);
    const tools = listItems(fields.tools);
    const model = unquote(fields.model);
    agents.push({
      path: file, bytes: content.bytes, name: unquote(fields.name) || path.posix.basename(file).replace(/\.md$/i, ''),
      model: ['', 'inherit'].includes(model.toLowerCase()) ? null : model,
      allTools: content.text !== null && (!tools.length || tools.includes('*')),
      dispatcher: tools.some(tool => DISPATCH_TOOLS.has(/^[\w.-]+/.exec(tool)?.[0].toLowerCase())),
    });
  }

  const skills = [];
  for (const folder of list('.claude/skills', /./, true)) {
    const content = read(`${folder}/SKILL.md`, root, 'skill');
    if (!content) continue;
    const { fields } = parsed(content.text);
    skills.push({
      bytes: content.bytes, descriptionBytes: Buffer.byteLength(unquote(fields.description)),
      modelInvocable: !/^true$/i.test(unquote(fields['disable-model-invocation'])),
    });
  }
  const commands = tree('.claude/commands', MARKDOWN).map(file => read(file, root, 'command')).filter(Boolean);

  const hooks = [];
  const broad = new Map();
  const settings = SETTINGS_FILES.map(file => [file, jsonFor(file, 'settings')]).filter(([, json]) => json);
  for (const [file, json] of settings) {
    try {
      for (const entry of hookEntries(json)) hooks.push({ path: file, ...entry });
    } catch (error) {
      if (error.code !== 'INVALID_INPUT') throw error;
      issue(file, 'INVALID_HOOKS', error.message);
    }
    const { permissions } = json;
    if (permissions !== undefined && !(isObject(permissions) && (permissions.allow === undefined || Array.isArray(permissions.allow)))) {
      issue(file, 'INVALID_PERMISSIONS', 'permissions must be an object whose allow field is an array.');
    } else if (permissions) {
      if (permissions.defaultMode === 'bypassPermissions') broad.set(`${file}: defaultMode bypassPermissions`, true);
      for (const rule of permissions.allow ?? []) {
        const compact = typeof rule === 'string' ? rule.replace(/\s+/g, '') : '';
        if (BROAD_RULE.test(compact)) broad.set(`${file}: allow ${compact}`, true);
      }
    }
    if (json.enableAllProjectMcpServers === true) broad.set(`${file}: enableAllProjectMcpServers`, false);
  }
  const risky = [];
  for (const hook of hooks) {
    for (const command of hook.commands) {
      const reasons = [NETWORK.test(command) && 'network fetch', PIPED.test(command) && 'pipe into an interpreter',
        unpinnedLaunches(command.split(/\s+/)) > 0 && 'unpinned package launcher'].filter(Boolean);
      if (reasons.length) risky.push({ path: hook.path, reasons });
    }
  }

  const mcp = jsonFor('.mcp.json', 'mcp');
  const servers = mcp?.mcpServers === undefined ? {} : mcp.mcpServers;
  if (!isObject(servers)) issue('.mcp.json', 'INVALID_MCP', 'mcpServers must be an object.');
  const remote = [];
  const unpinned = [];
  const secrets = [];
  for (const [name, server] of Object.entries(isObject(servers) ? servers : {})) {
    if (!isObject(server)) {
      issue('.mcp.json', 'INVALID_MCP', 'Each MCP server must be an object.');
      continue;
    }
    if (typeof server.url === 'string' || REMOTE_TYPES.has(server.type)) remote.push(name);
    const words = [server.command, ...(Array.isArray(server.args) ? server.args : [])]
      .filter(word => typeof word === 'string').flatMap(word => word.split(/\s+/));
    if (unpinnedLaunches(words)) unpinned.push(name);
    for (const field of ['env', 'headers']) {
      for (const [key, value] of Object.entries(isObject(server[field]) ? server[field] : {})) {
        if (SECRET_KEY.test(key) && looksSecret(value)) secrets.push(`${name}.${field}.${key}`);
      }
    }
  }
  const mcpServers = isObject(servers) ? Object.keys(servers).length : 0;

  const { files, source, truncated } = inventory(root, issue);
  const nestedPaths = files.filter(file => NESTED_GUIDE.test(file) && !file.startsWith('.claude/') &&
    !ROOT_INSTRUCTIONS.includes(file) && !alwaysOn.has(file));
  const nested = [];
  for (const file of nestedPaths.slice(0, MAX_GUIDES)) {
    const stats = stat(file);
    if (stats?.isFile()) nested.push({ path: file, bytes: stats.size });
  }
  const memory = new Map();
  const remember = file => {
    if (memory.has(file) || !(MEMORY_PATH.test(file) || MEMORY_NAME.test(file))) return;
    const stats = stat(file);
    if (stats?.isFile()) memory.set(file, { path: file, bytes: stats.size });
  };
  for (const file of files) if (file.startsWith('.claude/')) remember(file);

  const readFiles = [...cache.values()].filter(item => item && item.text !== null);
  const referenced = new Map();
  const checked = new Set();
  for (const item of readFiles) {
    if (!item.local || !INSTRUCTION_KINDS.has(item.kind)) continue;
    if (alwaysOn.has(item.path)) remember(item.path);
    for (const match of item.text.matchAll(REFERENCE)) {
      const target = match[1].replace(/^\.\//, '');
      if (alwaysOn.has(item.path)) remember(target);
      if (checked.has(target)) continue;
      checked.add(target);
      const stats = stat(target);
      if (stats?.isFile() && stats.size > 32 * KIB) referenced.set(target, { path: target, bytes: stats.size });
    }
  }
  const hidden = [];
  const injected = [];
  for (const item of readFiles) {
    const count = (item.text.replace(/^\uFEFF/, '').match(HIDDEN) ?? []).length;
    if (count) hidden.push({ path: item.path, count });
    if (!INSTRUCTION_KINDS.has(item.kind)) continue;
    const lines = [];
    for (const [index, line] of item.text.split(/\r\n|\r|\n/).entries()) {
      if (INJECTION.some(pattern => pattern.test(line))) lines.push(index + 1);
    }
    if (lines.length) injected.push({ path: item.path, lines: lines.slice(0, MAX_LISTED), lineCount: lines.length });
  }

  const always = [...alwaysOn.values()];
  const ancestors = always.filter(item => item.kind === 'ancestor');
  const imported = always.filter(item => item.kind === 'import');
  const alwaysOnBytes = total(always);
  if (alwaysOnBytes > 8 * KIB) {
    add(alwaysOnBytes > 16 * KIB ? 'high' : 'medium', 'ALWAYS_ON_LARGE',
      `${kib(alwaysOnBytes)} KiB of always-on Claude Code text in ${always.length} file(s), including ${ancestors.length} ancestor and ` +
      `${imported.length} imported file(s) (about ${Math.ceil(alwaysOnBytes / 4)} tokens at bytes/4)` +
      `${outside.size ? `; ${outside.size} import(s) outside the project were not read` : ''}.`,
      'Keep always-on text to commands, layout, and hard rules (8 KiB or less) and move procedures into skills or path-scoped rules.');
  }
  const long = always.filter(item => item.text !== null).map(item => ({ path: item.path, lines: lineCount(item.text) }))
    .filter(item => item.lines > MAX_LINES).sort((a, b) => b.lines - a.lines);
  if (long.length) {
    add('low', 'LONG_INSTRUCTION_FILE',
      `${long.length} always-on file(s) exceed ${MAX_LINES} lines: ${named(long.map(item => `${short(item.path, 120)} (${item.lines} lines)`))}; ` +
      'every session pays for these lines as recurring tokens.',
      `Claude Code docs target under ${MAX_LINES} lines per memory file, so move detail into skills or path-scoped rules.`);
  }
  if (agents.length > 4) {
    add('medium', 'MANY_AGENTS', `${agents.length} custom agents in .claude/agents.`,
      'Keep specialists that earn their handoff cost and prefer on-demand skills for phases that share context.');
  }
  const dispatchers = agents.filter(agent => agent.dispatcher);
  if (dispatchers.length && agents.length >= 3) {
    add('medium', 'ROUTER_AGENT', `${named(dispatchers.map(agent => (agent.model ? `${short(agent.name)} (${short(agent.model)})` : short(agent.name))))} ` +
      'declare the Agent or Task tool; this structural indicator does not establish that they only route.',
      'Keep one owner agent able to implement the task rather than a routing-only agent.');
  }
  const allTools = agents.filter(agent => agent.allTools);
  if (allTools.length) {
    add('low', 'AGENTS_WITH_ALL_TOOLS',
      `${allTools.length} agent(s) have no tools field and inherit every tool: ${named(allTools.map(agent => short(agent.name)))}. ` +
      'Structural indicator: one harness study (arXiv 2609.32459) found general-purpose subagents hurt results.',
      'List only the tools each agent needs in its tools field.');
  }
  const models = new Map();
  for (const agent of agents) if (agent.model) models.set(agent.model, (models.get(agent.model) ?? 0) + 1);
  const ranked = [...models].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1));
  const pinnedModels = Object.create(null);
  for (const [index, [model, count]] of ranked.slice(0, MAX_LISTED).entries()) {
    let display = short(model);
    while (Object.hasOwn(pinnedModels, display) || display === '(other models)') display += ` [${index + 1}]`;
    pinnedModels[display] = count;
  }
  if (ranked.length > MAX_LISTED) pinnedModels['(other models)'] = ranked.slice(MAX_LISTED).reduce((sum, [, count]) => sum + count, 0);
  const pinnedCount = ranked.reduce((sum, [, count]) => sum + count, 0);
  if (pinnedCount) {
    add('info', 'PINNED_MODELS', `${pinnedCount} agent(s) declare a model: ${named(ranked.map(([model, count]) => `${short(model)} x${count}`))}.`,
      'Inherit the session model unless a task measurably needs a different capability or cost profile.');
  }
  const broadHooks = hooks.filter(hook => hook.everyTool);
  const perTool = broadHooks.reduce((sum, hook) => sum + hook.handlers, 0);
  const hookFiles = items => [...new Set(items.map(hook => hook.path))];
  if (perTool) {
    add(perTool >= 5 ? 'high' : 'medium', 'PER_TOOL_HOOKS',
      `${perTool} hook handler(s) on PreToolUse/PostToolUse use broad matchers (${named(hookFiles(broadHooks))}); runtime cost was not measured.`,
      'Keep authorization and safety guards, measure hook time, and narrow matchers on redundant bookkeeping hooks.');
  }
  if (risky.length) {
    add('medium', 'RISKY_HOOK',
      `${risky.length} hook command(s) in ${named(hookFiles(risky))} show risk signs (${named([...new Set(risky.flatMap(item => item.reasons))])}); ` +
      'commands are not shown.',
      'Pin launched packages to exact versions and run reviewed local scripts instead of downloaded code.');
  }
  if (mcpServers > 8) {
    add('low', 'MANY_MCP_SERVERS', `${mcpServers} MCP servers are configured in .mcp.json.`,
      'Remove unused integrations after checking the session trace, since tool discovery may be deferred.');
  }
  if (unpinned.length) {
    add('medium', 'MCP_UNPINNED', `${unpinned.length} MCP server(s) launch npx, uvx, or pipx packages without a pinned version: ` +
      `${named(unpinned.map(name => short(name)))}.`,
      'Pin each launched package to an exact version so a registry update cannot change the server.');
  }
  if (remote.length) {
    add('info', 'MCP_REMOTE', `${remote.length} MCP server(s) connect to a remote URL: ${named(remote.map(name => short(name)))}.`,
      'Confirm that each remote server is trusted and that its credentials come from environment variables.');
  }
  if (secrets.length) {
    add('high', 'MCP_INLINE_SECRET', `${secrets.length} secret-looking literal value(s) in .mcp.json: ${named(secrets.map(key => short(key)))}; values are not shown.`,
      'Reference secrets as ${VAR} environment variables and rotate any value that was committed.');
  }
  if (broad.size) {
    add([...broad.values()].some(Boolean) ? 'high' : 'medium', 'BROAD_PERMISSIONS',
      `Broad permission settings: ${named([...broad.keys()].map(key => short(key, 120)))}.`,
      'Allow specific commands instead of every shell command and enable MCP servers individually.');
  }
  if (hidden.length) {
    add('high', 'HIDDEN_UNICODE', `${hidden.length} file(s) contain invisible or bidirectional Unicode characters: ` +
      `${named(hidden.map(item => `${short(item.path, 120)} (${item.count})`))}.`,
      'Inspect and remove invisible characters, which can hide instructions from human review.');
  }
  if (injected.length) {
    add('low', 'INJECTION_LIKE', `${injected.length} file(s) contain prompt-injection-like lines: ` +
      `${named(injected.map(item => `${short(item.path, 120)} line ${item.lines.slice(0, 3).join(', ')}${item.lineCount > 3 ? ', ...' : ''}`))}.`,
      'Read the flagged lines and remove any text that hides actions from the user or overrides earlier guidance.');
  }
  const memoryFiles = [...memory.values()];
  const memoryBytes = total(memoryFiles);
  if (memoryBytes > 32 * KIB) {
    const [top] = largest(memoryFiles, 1);
    add(memoryBytes > 128 * KIB ? 'high' : 'medium', 'MEMORY_UNBOUNDED',
      `${memoryFiles.length} memory-like file(s) under .claude or referenced from always-on text total ${kib(memoryBytes)} KiB; ` +
      `largest ${short(top.path, 180)} (${kib(top.bytes)} KiB). Their presence does not prove they are loaded.`,
      'Keep loaded memory small and evidence-backed, and retrieve larger notes by section instead of whole files.');
  }
  const referencedFiles = largest(referenced.values());
  if (referencedFiles.length) {
    add(referencedFiles[0].bytes > 128 * KIB ? 'high' : 'medium', 'LARGE_REFERENCED_FILES',
      `Instructions mention ${referenced.size} file(s) over 32 KiB; largest ${short(referencedFiles[0].path, 180)} ` +
      `(${kib(referencedFiles[0].bytes)} KiB). A mention is not proof of a full read.`,
      'Point instructions at a short summary or a specific section instead of whole reports, ledgers, or logs.');
  }
  if (!always.some(item => item.text !== null && TEST_COMMAND.test(item.text))) {
    add('info', 'NO_TEST_COMMAND', 'No always-on text mentions a recognizable test command.',
      'Name the exact test command in CLAUDE.md so each session can verify its changes.');
  }

  const order = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((left, right) => order[left.severity] - order[right.severity]);
  const counts = Object.fromEntries(Object.keys(order).map(level => [level, findings.filter(item => item.severity === level).length]));
  const complete = skipped.length === 0 && !truncated && nestedPaths.length <= MAX_GUIDES;
  const project = always.filter(item => item.kind === 'project');
  const unscoped = always.filter(item => item.kind === 'rule');
  const report = {
    ok: complete && counts.high === 0, complete,
    project: root,
    summary: `${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.info} info`,
    alwaysOn: {
      bytes: alwaysOnBytes, approxTokens: Math.ceil(alwaysOnBytes / 4), files: largest(always),
      longFiles: long.slice(0, MAX_LISTED).map(item => ({ path: item.path, lines: item.lines })),
    },
    ancestors: { ...tally(ancestors), files: largest(ancestors) },
    imports: {
      ...tally(imported), missing: missing.size, beyondHopLimit: beyond.size, maxHops: MAX_IMPORT_HOPS,
      unreadOutsideCount: outside.size, unreadOutside: [...outside].slice(0, MAX_LISTED).map(file => short(file, 200)),
    },
    onDemand: {
      count: scoped.length + nested.length, bytes: total(scoped) + total(nested), scopedRules: scoped.length,
      nestedGuides: nestedPaths.length, nestedTruncated: nestedPaths.length > MAX_GUIDES, largest: largest([...scoped, ...nested], 5),
    },
    agents: {
      count: agents.length, bytes: total(agents),
      dispatcherCount: dispatchers.length, dispatchers: dispatchers.slice(0, MAX_LISTED).map(agent => short(agent.name)),
      allToolsCount: allTools.length, allTools: allTools.slice(0, MAX_LISTED).map(agent => short(agent.name)),
      pinnedModels, pinnedModelCount: ranked.length, pinnedAgentCount: pinnedCount, largest: largest(agents, 5),
    },
    skills: {
      count: skills.length, modelInvocable: skills.filter(skill => skill.modelInvocable).length,
      descriptionBytes: skills.reduce((sum, skill) => sum + skill.descriptionBytes, 0), bodyBytes: total(skills),
    },
    hooks: {
      handlers: hooks.reduce((sum, hook) => sum + hook.handlers, 0), commands: hooks.reduce((sum, hook) => sum + hook.commands.length, 0),
      everyToolCall: perTool, risky: risky.length, files: hookFiles(hooks).slice(0, MAX_LISTED),
    },
    permissions: { broad: [...broad.keys()].slice(0, MAX_LISTED).map(key => short(key, 120)) },
    mcp: {
      servers: mcpServers, remote: remote.slice(0, MAX_LISTED).map(name => short(name)), unpinned: unpinned.slice(0, MAX_LISTED).map(name => short(name)),
      inlineSecretCount: secrets.length, inlineSecretKeys: secrets.slice(0, MAX_LISTED).map(key => short(key)),
    },
    memory: { files: memoryFiles.length, bytes: memoryBytes, largest: largest(memoryFiles, 5) },
    referencedLargeFiles: referencedFiles,
    hiddenUnicode: hidden.slice(0, MAX_LISTED),
    injectionLike: injected.slice(0, MAX_LISTED),
    findings,
    inventory: {
      source, paths: files.length, truncated,
      surfaces: {
        instructions: tally(project), imports: tally(imported), ancestors: tally(ancestors), unscopedRules: tally(unscoped),
        scopedRules: tally(scoped), nestedGuides: tally(nested), agents: tally(agents), skills: tally(skills), commands: tally(commands),
        settings: tally(settings.map(([file]) => cache.get(file))), mcp: { ...tally(mcp ? [cache.get('.mcp.json')] : []), servers: mcpServers },
      },
    },
    skipped: skipped.slice(0, MAX_LISTED),
    skippedCount: skipped.length,
    output: { maxBytes: AUDIT_BYTES, truncated: false },
    note: NOTE,
  };
  const details = [report.alwaysOn.files, report.alwaysOn.longFiles, report.ancestors.files, report.imports.unreadOutside,
    report.onDemand.largest, report.agents.largest, report.agents.dispatchers, report.agents.allTools, report.hooks.files,
    report.permissions.broad, report.mcp.remote, report.mcp.unpinned, report.mcp.inlineSecretKeys, report.memory.largest,
    report.referencedLargeFiles, report.hiddenUnicode, report.injectionLike, report.skipped];
  const size = () => Buffer.byteLength(`${JSON.stringify(report)}\n`);
  while (size() > AUDIT_BYTES) {
    const longest = details.filter(items => items.length).sort((a, b) =>
      Buffer.byteLength(JSON.stringify(b)) - Buffer.byteLength(JSON.stringify(a)))[0];
    if (longest) longest.pop();
    else {
      const finding = findings.filter(item => item.message.length > 160).sort((a, b) => b.message.length - a.message.length)[0];
      requireThat(finding, 'Audit summary exceeds its output budget.', 'OUTPUT_LIMIT');
      finding.message = short(finding.message, 160);
    }
    report.output.truncated = true;
  }
  return report;
}
