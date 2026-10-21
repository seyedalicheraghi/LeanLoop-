import fs from 'node:fs';
import {
  CONFIG_FILE, STATE_DIR, atomicFile, projectRoot, readJson, requireThat, safePath, withLock,
} from './io.mjs';
import { DEFAULT_CONFIG, validateConfig } from './schema.mjs';

const STATE_IGNORE = `${STATE_DIR}/.gitignore`;
// Markers of a pre-rename (0.3.0 and earlier) install, which is never migrated implicitly.
const RENAMED_FROM = ['.lean-workflow/install.json', 'lean-workflow.json'];
// Files that 0.4.0 copied into projects. With the plugin installed they duplicate its skill and reviewer.
const VENDORED = [
  '.leanloop/install.json', '.agents/skills/leanloop', '.github/skills/leanloop', '.claude/skills/leanloop',
  '.github/agents/leanloop-reviewer.agent.md', '.claude/agents/leanloop-reviewer.md',
];

const exists = (root, file) => fs.existsSync(safePath(root, file));

// The plugin supplies skills and the reviewer; a project only needs its check configuration and ignored state.
export async function init(target, dryRun = false) {
  const root = projectRoot(target);
  function plan() {
    for (const file of RENAMED_FROM) {
      requireThat(!exists(root, file),
        `Found a lean-workflow install from before the LeanLoop rename (${file}). ` +
        'It is not migrated automatically; follow "Moving from lean-workflow" in docs/migration.md.', 'LEGACY_INSTALL');
    }
    const files = [];
    if (exists(root, CONFIG_FILE)) validateConfig(readJson(root, CONFIG_FILE));
    else files.push({ path: CONFIG_FILE, content: `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n` });
    if (!exists(root, STATE_IGNORE)) files.push({ path: STATE_IGNORE, content: '*\n' });
    else {
      requireThat(fs.lstatSync(safePath(root, STATE_IGNORE)).isFile() && fs.readFileSync(safePath(root, STATE_IGNORE), 'utf8') === '*\n',
        `${STATE_IGNORE} was changed; restore it to a single "*" line so task state and logs stay out of Git.`);
    }
    return { files, vendoredCopies: VENDORED.filter(file => exists(root, file)) };
  }
  const report = ({ files, vendoredCopies }, created) => ({
    ok: true, project: root, dryRun, created, preservedConfig: !files.some(file => file.path === CONFIG_FILE),
    ...(vendoredCopies.length ? {
      vendoredCopies,
      warning: 'These copies from LeanLoop 0.4.0 duplicate the plugin. Compare and remove them yourself (docs/migration.md).',
    } : {}),
    next: 'Run doctor for suggested checks, review one, run it by hand, then record it with add-check.',
  });
  const planned = plan();
  if (dryRun) return report(planned, planned.files.map(file => file.path));
  return withLock(root, async () => {
    const current = plan();
    for (const file of current.files) atomicFile(root, file.path, file.content, { exclusive: true, mode: 0o644 });
    return report(current, current.files.map(file => file.path));
  });
}
