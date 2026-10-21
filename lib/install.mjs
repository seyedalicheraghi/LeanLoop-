import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  CONFIG_FILE, atomicFile, atomicJson, projectRoot, readJson, requireThat, safePath, withLock,
} from '../skills/leanloop/scripts/lib/io.mjs';
import { DEFAULT_CONFIG, validateConfig } from '../skills/leanloop/scripts/lib/schema.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const REGISTRY = '.leanloop/install.json';
// Where each host family discovers project skills and custom agents (see SOURCES.md).
export const HOSTS = Object.freeze({
  portable: { skill: '.agents/skills/leanloop', reviewer: '.github/agents/leanloop-reviewer.agent.md', format: 'copilot' },
  copilot: { skill: '.github/skills/leanloop', reviewer: '.github/agents/leanloop-reviewer.agent.md', format: 'copilot' },
  claude: { skill: '.claude/skills/leanloop', reviewer: '.claude/agents/leanloop-reviewer.md', format: 'claude' },
});
const DEFAULT_HOSTS = ['portable'];
const LEGACY_HOSTS = ['copilot'];
// Markers of a pre-rename (0.3.0 and earlier) install, which is never migrated implicitly.
const RENAMED_FROM = ['.lean-workflow/install.json', 'lean-workflow.json'];
const digest = content => createHash('sha256').update(content).digest('hex');
const managed = file => file === '.leanloop/.gitignore' ||
  Object.values(HOSTS).some(host => file.startsWith(`${host.skill}/`) || file === host.reviewer);

function claudeReviewer(content) {
  const text = content.toString('utf8');
  const converted = text.replace(/^tools: \["read", "search"\]$/m, 'tools: Read, Grep, Glob');
  requireThat(converted !== text, 'The reviewer frontmatter changed; update its Claude conversion.');
  return Buffer.from(converted);
}

function assets(hosts) {
  const entries = new Map();
  function walk(source, destination) {
    for (const item of fs.readdirSync(source, { withFileTypes: true })) {
      const input = path.join(source, item.name);
      const output = `${destination}/${item.name}`;
      requireThat(!item.isSymbolicLink(), `Distribution contains a symlink: ${output}`);
      if (item.isDirectory()) walk(input, output);
      else {
        requireThat(item.isFile(), `Distribution contains a non-regular file: ${output}`);
        entries.set(output, fs.readFileSync(input));
      }
    }
  }
  const reviewer = fs.readFileSync(path.join(packageRoot, 'agents/leanloop-reviewer.agent.md'));
  for (const name of hosts) {
    const host = HOSTS[name];
    walk(path.join(packageRoot, 'skills/leanloop'), host.skill);
    entries.set(host.reviewer, host.format === 'claude' ? claudeReviewer(reviewer) : reviewer);
  }
  entries.set('.leanloop/.gitignore', Buffer.from('*\n'));
  return [...entries].map(([file, content]) => ({ path: file, content }));
}

function chooseHosts(requested, previousRegistry) {
  const hosts = requested?.length ? requested : previousRegistry?.hosts ?? (previousRegistry ? LEGACY_HOSTS : DEFAULT_HOSTS);
  for (const host of hosts) {
    requireThat(Object.hasOwn(HOSTS, host), `Unknown host "${host}". Use one or more of: ${Object.keys(HOSTS).join(', ')}.`);
  }
  requireThat(hosts.length > 0, 'Choose at least one host.');
  return [...new Set(hosts)];
}

function removeEmptyParents(root, file) {
  const skillRoot = Object.values(HOSTS).map(host => host.skill).find(skill => file.startsWith(`${skill}/`));
  if (!skillRoot) return;
  for (let directory = path.posix.dirname(file); directory.startsWith(skillRoot); directory = path.posix.dirname(directory)) {
    try {
      fs.rmdirSync(safePath(root, directory));
    } catch {
      return;
    }
  }
}

export async function install(target, dryRun = false, upgrade = false, requestedHosts = undefined) {
  const root = projectRoot(target);
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;

  function plan() {
    for (const file of RENAMED_FROM) {
      requireThat(!fs.existsSync(safePath(root, file)),
        `Found a lean-workflow install from before the LeanLoop rename (${file}). ` +
        'It is not migrated automatically; follow "Moving from lean-workflow" in docs/migration.md.', 'LEGACY_INSTALL');
    }
    const preservedConfig = fs.existsSync(safePath(root, CONFIG_FILE));
    if (preservedConfig) validateConfig(readJson(root, CONFIG_FILE));
    const previousRegistry = readJson(root, REGISTRY, true);
    if (previousRegistry) {
      requireThat(previousRegistry.version === 1 && previousRegistry.files &&
        typeof previousRegistry.files === 'object' && !Array.isArray(previousRegistry.files), 'Invalid installation registry.');
      requireThat(previousRegistry.hosts === undefined || (Array.isArray(previousRegistry.hosts) && previousRegistry.hosts.length > 0 &&
        previousRegistry.hosts.every(host => Object.hasOwn(HOSTS, host))), 'Invalid hosts in installation registry.');
      for (const [file, hash] of Object.entries(previousRegistry.files)) {
        safePath(root, file);
        requireThat(managed(file) && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash), 'Invalid managed file in installation registry.');
      }
    }
    const hosts = chooseHosts(requestedHosts, previousRegistry);
    const entries = assets(hosts);
    const registry = { version: 1, packageVersion: version, hosts, files: Object.fromEntries(entries.map(entry => [entry.path, digest(entry.content)])) };
    const desired = preservedConfig ? entries : [...entries, {
      path: CONFIG_FILE, content: Buffer.from(`${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`),
    }];
    const changes = [];
    for (const entry of desired) {
      const destination = safePath(root, entry.path);
      if (!fs.existsSync(destination)) {
        changes.push({ ...entry, previous: null });
        continue;
      }
      requireThat(fs.statSync(destination).isFile(), `Installation path is not a regular file: ${entry.path}`);
      const previous = fs.readFileSync(destination);
      if (previous.equals(entry.content)) continue;
      requireThat(upgrade && managed(entry.path) && previousRegistry?.files[entry.path] === digest(previous),
        `Refusing to overwrite existing customization or older runtime: ${entry.path}. ` +
        'Use --upgrade only for unmodified registered files; otherwise back up and reconcile explicitly.');
      changes.push({ ...entry, previous });
    }
    for (const [file, hash] of Object.entries(previousRegistry?.files ?? {})) {
      if (Object.hasOwn(registry.files, file) || !fs.existsSync(safePath(root, file))) continue;
      const previous = fs.readFileSync(safePath(root, file));
      requireThat(upgrade && digest(previous) === hash,
        `Retired managed file needs explicit upgrade or reconciliation: ${file}`);
      changes.push({ path: file, content: null, previous });
    }
    return { changes, previousRegistry, preservedConfig, hosts, registry };
  }
  const planned = plan();
  if (dryRun) return {
    ok: true, dryRun: true, upgrade, project: root, hosts: planned.hosts,
    files: planned.changes.map(entry => ({ path: entry.path, action: entry.content === null ? 'remove' : entry.previous ? 'replace' : 'create' })),
  };
  return withLock(root, async () => {
    const current = plan();
    const applied = [];
    try {
      for (const entry of current.changes) {
        if (entry.content === null) fs.unlinkSync(safePath(root, entry.path));
        else atomicFile(root, entry.path, entry.content, { exclusive: entry.previous === null, mode: 0o644 });
        applied.push(entry);
      }
      if (JSON.stringify(current.previousRegistry) !== JSON.stringify(current.registry)) atomicJson(root, REGISTRY, current.registry);
    } catch (error) {
      const failures = [];
      for (const entry of applied.reverse()) {
        try {
          const destination = safePath(root, entry.path);
          requireThat(entry.content === null ? !fs.existsSync(destination) : fs.readFileSync(destination).equals(entry.content),
            `Concurrent change prevents rollback: ${entry.path}`);
          if (entry.previous === null) fs.unlinkSync(destination);
          else atomicFile(root, entry.path, entry.previous, { exclusive: entry.content === null, mode: 0o644 });
        } catch (rollbackError) {
          failures.push(rollbackError.message);
        }
      }
      if (failures.length) throw new Error(`Installation failed: ${error.message}. Rollback needs attention: ${failures.join('; ')}`);
      throw error;
    }
    for (const entry of applied) if (entry.content === null) removeEmptyParents(root, entry.path);
    const skills = current.hosts.map(host => `${HOSTS[host].skill}/scripts/workflow.mjs`);
    return {
      ok: true, project: root, version, upgrade, hosts: current.hosts,
      created: applied.filter(entry => entry.previous === null).map(entry => entry.path),
      updated: applied.filter(entry => entry.previous !== null && entry.content !== null).map(entry => entry.path),
      removed: applied.filter(entry => entry.content === null).map(entry => entry.path),
      preservedConfig: current.preservedConfig, runtime: skills[0],
      next: `Configure real checks (node ${skills[0]} doctor suggests some), then run doctor. Unrelated project instructions and agents were not changed.`,
    };
  });
}
