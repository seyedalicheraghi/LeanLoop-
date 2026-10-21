import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const plugin = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
assert.equal(plugin.version, manifest.version);
assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
assert.equal(Object.keys(manifest.devDependencies ?? {}).length, 0);
assert.equal(manifest.private, true);
assert.equal(fs.existsSync(path.join(root, 'hooks')), false);
const skill = fs.readFileSync(path.join(root, 'skills/leanloop/SKILL.md'), 'utf8');
const reviewer = fs.readFileSync(path.join(root, 'agents/leanloop-reviewer.agent.md'), 'utf8');
const skillHeader = /^---\nname: leanloop\ndescription: "(.+)"\nlicense: MIT\n---\n/.exec(skill);
assert.ok(skillHeader, 'SKILL.md frontmatter must be name, quoted description, and license.');
assert.ok(skillHeader[1].length <= 1024, 'Agent Skills descriptions are limited to 1024 characters.');
assert.match(reviewer, /^---\nname: leanloop-reviewer\ndescription: .+\ntools: \["read", "search"\]\n---/);
assert.ok(Buffer.byteLength(skill) + Buffer.byteLength(reviewer) <= 8192, 'Customization bodies exceed their combined 8 KiB budget.');
assert.doesNotMatch(reviewer, /^model:|^handoffs:/m);

let scripts = 0;
let markdownFiles = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', '.leanloop', 'dist'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `Unexpected package symlink: ${file}`);
    if (entry.isDirectory()) walk(file);
    else if (entry.name.endsWith('.mjs')) {
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
process.stdout.write(`${JSON.stringify({
  ok: true, syntaxCheckedScripts: scripts, markdownFiles,
  customizationBytes: Buffer.byteLength(skill) + Buffer.byteLength(reviewer),
  customizationBudgetBytes: 8192, dependencies: 0, privateTermsChecked,
})}\n`);
