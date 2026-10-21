import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('package.json'));
const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'));
assert.equal(plugin.name, 'leanloop');
assert.equal(plugin.version, manifest.version);
assert.deepEqual(marketplace.plugins.map(entry => [entry.name, entry.source]), [[plugin.name, './']]);
assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
assert.equal(Object.keys(manifest.devDependencies ?? {}).length, 0);
assert.equal(manifest.private, true);
// No hooks, MCP servers, or PATH additions: the plugin only ships on-demand instructions and a reviewer.
for (const absent of ['hooks', '.mcp.json', 'bin', 'commands', 'settings.json']) assert.equal(fs.existsSync(path.join(root, absent)), false, absent);

const SKILLS = ['work', 'setup', 'audit'];
assert.deepEqual(fs.readdirSync(path.join(root, 'skills')).sort(), [...SKILLS].sort());
const skills = Object.fromEntries(SKILLS.map(name => [name, read(`skills/${name}/SKILL.md`)]));
for (const [name, skill] of Object.entries(skills)) {
  const header = new RegExp(`^---\\nname: ${name}\\ndescription: "([^"\\n]+)"\\n(?:argument-hint: "[^"\\n]+"\\n|disable-model-invocation: true\\n)?license: MIT\\n---\\n`).exec(skill);
  assert.ok(header, `skills/${name}/SKILL.md frontmatter must be name, quoted description, an optional hint or opt-in flag, and license.`);
  assert.ok(header[1].length <= 300, `${name}: keep the always-listed description short.`);
  assert.match(skill, /\$\{CLAUDE_PLUGIN_ROOT\}\/leanloop\.mjs/, `${name} must call the plugin's bundled CLI.`);
}
const reviewer = read('agents/leanloop-reviewer.md');
assert.match(reviewer, /^---\nname: leanloop-reviewer\ndescription: "[^"\n]+"\ntools: Read, Grep, Glob\n---\n/);
assert.doesNotMatch(reviewer, /^(model|hooks|mcpServers|permissionMode):/m);
const bytes = text => Buffer.byteLength(text);
const coreBytes = bytes(skills.work) + bytes(reviewer);
const allBytes = Object.values(skills).reduce((sum, skill) => sum + bytes(skill), bytes(reviewer));
assert.ok(coreBytes <= 8192, 'The work skill and reviewer exceed their combined 8 KiB budget.');
assert.ok(allBytes <= 12288, 'All skills plus the reviewer exceed their 12 KiB budget.');
// Invisible tag, zero-width, and bidirectional control characters can hide instructions (see SOURCES.md).
const HIDDEN = /[\u{E0000}-\u{E007F}\u200B-\u200D\u2060\u202A-\u202E\u2066-\u2069\uFEFF]/u;

let scripts = 0;
let markdownFiles = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', '.leanloop', 'dist'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `Unexpected package symlink: ${file}`);
    if (entry.isDirectory()) walk(file);
    else if (/\.(mjs|md|json)$/.test(entry.name)) {
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), HIDDEN, `Invisible or bidirectional Unicode in ${file}`);
    }
    if (entry.name.endsWith('.mjs')) {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      scripts += 1;
    } else if (entry.name.endsWith('.md')) {
      markdownFiles += 1;
      const contents = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(contents, /\/(?:home|Users)\/[a-zA-Z0-9_.-]+\//, 'Documentation contains a machine-specific home path.');
      for (const match of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1].split('#')[0];
        if (!target || /^[a-z]+:/i.test(target)) continue;
        assert.ok(fs.existsSync(path.resolve(path.dirname(file), target)), `Broken documentation link in ${file}: ${target}`);
      }
    }
  }
}
walk(root);

// Optional publishing guard: terms live outside the package, one per line, so they never enter it.
let privateTermsChecked = 0;
const denylist = process.env.LEANLOOP_DENYLIST_FILE;
if (denylist) {
  const terms = fs.readFileSync(denylist, 'utf8').split('\n').map(line => line.trim().toLowerCase()).filter(Boolean);
  const hits = [];
  const scan = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', '.git', '.leanloop', 'dist'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (entry.isFile()) {
        const contents = `${path.relative(root, file)}\n${fs.readFileSync(file, 'utf8')}`.toLowerCase();
        for (const [index, term] of terms.entries()) if (contents.includes(term)) hits.push(`${path.relative(root, file)} (term #${index + 1})`);
      }
    }
  };
  scan(root);
  assert.deepEqual(hits, [], `Private terms found: ${hits.join(', ')}`);
  privateTermsChecked = terms.length;
}
// Claude Code's own validator, when installed; the package stays usable without it.
let claudeValidate = 'unavailable';
try {
  for (const target of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'skills', 'agents']) {
    execFileSync('claude', ['plugin', 'validate', '--strict', path.join(root, target)], {
      stdio: 'pipe', timeout: 60000,
    });
  }
  claudeValidate = 'passed';
} catch (error) {
  assert.equal(error.code, 'ENOENT', `claude plugin validate --strict failed: ${String(error.stdout ?? '').slice(-800)}`);
}
process.stdout.write(`${JSON.stringify({
  ok: true, syntaxCheckedScripts: scripts, markdownFiles, coreBytes, coreBudgetBytes: 8192,
  allSkillBytes: allBytes, allSkillBudgetBytes: 12288, dependencies: 0, privateTermsChecked, claudeValidate,
})}\n`);
