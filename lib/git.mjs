import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { CONFIG_FILE, WorkflowError, relativePath, requireThat, safePath } from './io.mjs';
import { LESSONS_FILE } from './lessons.mjs';
import { CHECK_DEFINITION_PATHS, DEPENDENCY_DIRECTORIES, checkArgumentPaths, globPattern } from './schema.mjs';

const MAX_GIT_BYTES = 64 * 1024 * 1024;
// Index and inventory listings take about 120 bytes per path; 256 MiB covers roughly two million paths.
const MAX_LISTING_BYTES = 256 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 100000;
export const MAX_INVENTORY_FILES = 1000000;
const MAX_IGNORED_DEFINITIONS = 1000;
// Entries read inside Git-ignored directories other than dependency trees; about 0.3 s on a warm disk.
export const MAX_IGNORED_SCAN_ENTRIES = 250000;
// Workflow state and the lessons file are bookkeeping, not source; editing them must not invalidate evidence.
const EXCLUDE_STATE = ['--', '.', ':(exclude).leanloop/**', `:(exclude)${LESSONS_FILE}`];
const isBookkeeping = file => file.startsWith('.leanloop/') || file === LESSONS_FILE;

export function projectEnvironment() {
  const env = { ...process.env };
  const removed = [];
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_LITERAL_PATHSPECS',
    'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS']) {
    if (Object.hasOwn(env, key)) removed.push(key);
    delete env[key];
  }
  return { env, removed };
}

function git(root, args, allowedExit = [], maxBuffer = MAX_GIT_BYTES) {
  const { env } = projectEnvironment();
  env.GIT_OPTIONAL_LOCKS = '0';
  try {
    return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, ...args], {
      env, maxBuffer, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (allowedExit.includes(error.status)) return null;
    throw new WorkflowError(`Git ${args[0]} failed (${error.code ?? error.status}). ` +
      'Use a Git worktree root; keep generated artifacts ignored and diffs below 64 MiB.', 'GIT_FAILED');
  }
}

function decode(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new WorkflowError('Non-UTF-8 Git paths are not supported.', 'UNSUPPORTED_PATH');
  }
}

// The JS realpath keeps the caller's casing (c: versus C:); the native one resolves both sides the same way.
export function requireGitRoot(root) {
  const top = decode(git(root, ['rev-parse', '--show-toplevel'])).trim();
  const [found, given] = [top, root].map(value => fs.realpathSync.native(value));
  requireThat(process.platform === 'win32' ? found.toLowerCase() === given.toLowerCase() : found === given,
    'Use the Git worktree root as --project, not a nested directory.');
}

export function inventory(root) {
  requireGitRoot(root);
  const output = decode(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], [], MAX_LISTING_BYTES));
  const files = [...new Set(output.split('\0').filter(Boolean))].filter(file => !file.startsWith('.leanloop/'));
  requireThat(files.length <= MAX_INVENTORY_FILES,
    `Inventory exceeds ${MAX_INVENTORY_FILES} paths. Use your editor's scoped symbol/search tools instead.`, 'INVENTORY_LIMIT');
  return files;
}

// Checks "<tag> <mode> <object> <stage>\t<path>" records in place, so large indexes need no giant string.
export function checkIndexListing(listing) {
  requireThat(isUtf8(listing), 'Non-UTF-8 Git paths are not supported.', 'UNSUPPORTED_PATH');
  for (let start = 0; start < listing.length;) {
    let end = listing.indexOf(0, start);
    if (end === -1) end = listing.length;
    const tab = listing.indexOf(9, start);
    const [flag = '', mode, , stage] = listing.toString('latin1', start, tab === -1 || tab > end ? end : tab).split(' ');
    if (flag) {
      requireThat(flag !== 'S' && flag === flag.toUpperCase(),
        'Verification cannot cover skip-worktree or assume-unchanged files. Clear those flags or verify a separate worktree.', 'UNVERIFIABLE_INDEX');
      requireThat(mode !== '160000', 'Verify submodules as separate projects; parent-project submodule verification is not supported.', 'UNVERIFIABLE_INDEX');
      requireThat(stage === '0', 'Resolve merge conflicts before verification.', 'UNVERIFIABLE_INDEX');
    }
    start = end + 1;
  }
}

export function headCommit(root) {
  const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD'], [1]);
  return head === null ? null : decode(head).trim();
}

function untracked(root) {
  return decode(git(root, ['ls-files', '--others', '--exclude-standard', '-z'], [], MAX_LISTING_BYTES))
    .split('\0').filter(file => file && !isBookkeeping(file)).sort();
}

// Tracked and untracked source files, without workflow bookkeeping.
export const projectFiles = root => inventory(root).filter(file => !isBookkeeping(file));

// Files added, modified, deleted, or retyped between a commit and the worktree (staged changes included);
// untracked files are reported as additions.
export function changesSince(root, commit) {
  const output = decode(git(root, ['diff', '--name-status', '--no-renames', '-z', '--no-ext-diff', commit, ...EXCLUDE_STATE]));
  const fields = output.split('\0').filter(Boolean);
  const changed = [];
  for (let index = 0; index + 1 < fields.length; index += 2) changed.push({ status: fields[index][0], path: fields[index + 1] });
  for (const file of untracked(root)) changed.push({ status: 'A', path: file });
  return changed;
}

// Decides whether a path defines what a check runs: a known runner file (any letter case) or a file a command names.
export function definitionMatcher(checks) {
  const patterns = CHECK_DEFINITION_PATHS.map(glob => globPattern(glob, { ignoreCase: true }));
  const named = new Set(checkArgumentPaths(checks).map(file => file.toLowerCase()));
  return file => named.has(file.toLowerCase()) || patterns.some(pattern => pattern.test(file));
}

function configuredChecks(root) {
  try {
    return JSON.parse(fs.readFileSync(safePath(root, CONFIG_FILE), 'utf8')).checks;
  } catch {
    return [];
  }
}

const dependencyPatterns = DEPENDENCY_DIRECTORIES.map(glob => globPattern(glob));
// A directory path ending in "/" that lies in an installed dependency tree, such as "src/node_modules/".
const isDependencyDirectory = directory => dependencyPatterns.some(pattern => pattern.test(directory));

// Walks one wholly ignored directory for definition files. Git cannot match ignore rules inside it (an excluded
// directory cannot re-include children), so no rules are evaluated here. Dependency trees, nested repositories,
// and links are skipped, and budget caps the entries read across all ignored directories. Returns false once the
// budget is spent, leaving the caller to fall back to Git's own listing.
function scanIgnoredDirectory(root, start, isDefinition, found, budget) {
  const first = start.replace(/\/$/, '');
  // Children come from reading real directories (links are skipped), so only the starting path needs the link check.
  const pending = [[first, safePath(root, first)]];
  while (pending.length) {
    const [relative, absolute] = pending.pop();
    const children = [];
    let nestedRepository = false;
    const directory = fs.opendirSync(absolute);
    try {
      for (let entry; (entry = directory.readSync());) {
        budget.entries += 1;
        if (budget.entries > budget.limit) return false;
        if (entry.name === '.git') nestedRepository = true;
        else if (entry.isDirectory() || entry.isFile()) children.push(entry);
      }
    } finally {
      directory.closeSync();
    }
    // Git does not list files inside a nested repository, so neither does this scan.
    if (nestedRepository) continue;
    for (const entry of children) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!isDependencyDirectory(`${child}/`)) pending.push([child, path.join(absolute, entry.name)]);
      } else if (isDefinition(child)) found.push(child);
    }
  }
  return true;
}

// Git's full ignored listing descends into nested repositories inside ignored directories and, on Windows, through
// junctions; the scan does neither, so files reached that way are dropped from the fallback too.
function reachedLikeScan(root, file) {
  const parts = file.split('/');
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) return false;
    if (index < parts.length - 1 && fs.existsSync(path.join(current, '.git'))) return false;
  }
  return true;
}

// Check definitions Git ignores (.git/info/exclude, .gitignore) never appear in a diff or the untracked listing,
// so they are listed separately; installed dependency trees are left out. Git lists matching ignored files and
// collapses each wholly ignored directory to one entry (--directory) instead of reading every path inside it, so
// node_modules is never walked. Other ignored directories are scanned for definition names under a fixed budget;
// past it (a large dataset, build tree, or Rust target/), Git lists matching files itself: slower, since Git then
// walks dependency trees too, but without a limit, as before the scan existed.
export function ignoredDefinitionFiles(root, checks = configuredChecks(root),
  { maxEntries = MAX_IGNORED_SCAN_ENTRIES } = {}) {
  const isDefinition = definitionMatcher(checks);
  const pathspecs = [
    ...CHECK_DEFINITION_PATHS.map(glob => `:(glob,icase)${glob}`),
    ...checkArgumentPaths(checks).map(file => `:(literal,icase)${file}`),
    ':(exclude,glob).leanloop/**', ...DEPENDENCY_DIRECTORIES.map(glob => `:(exclude,glob)${glob}`),
  ];
  const listIgnored = extra => decode(git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', ...extra, '-z',
    '--', ...pathspecs], [], MAX_LISTING_BYTES)).split('\0').filter(entry => entry && !isBookkeeping(entry));
  const entries = listIgnored(['--directory']);
  let files = entries.filter(entry => !entry.endsWith('/') && isDefinition(entry));
  const budget = { entries: 0, limit: maxEntries };
  for (const directory of entries.filter(entry => entry.endsWith('/')).sort()) {
    if (isDependencyDirectory(directory) || scanIgnoredDirectory(root, directory, isDefinition, files, budget)) continue;
    files = listIgnored([]).filter(file => isDefinition(file) && reachedLikeScan(root, file));
    break;
  }
  const unique = [...new Set(files)].sort();
  requireThat(unique.length <= MAX_IGNORED_DEFINITIONS, `More than ${MAX_IGNORED_DEFINITIONS} Git-ignored check-definition ` +
    'files (package.json, conftest.py, .npmrc, ...) exist outside dependency directories; verification cannot cover them.', 'INVENTORY_LIMIT');
  return unique;
}

// Hashes one file without following links; the same encoding serves untracked and ignored files.
function hashFile(hash, root, file, budget) {
  relativePath(file);
  const absolute = path.join(root, file);
  const stat = fs.lstatSync(absolute);
  hash.update(`${Buffer.byteLength(file)}:${file}\0`);
  if (stat.isSymbolicLink()) {
    hash.update(`link:${fs.readlinkSync(absolute)}\0`);
    return;
  }
  requireThat(stat.isFile(), `Cannot fingerprint non-regular file: ${file}`);
  safePath(root, file);
  budget.bytes += stat.size;
  requireThat(budget.bytes <= MAX_UNTRACKED_BYTES,
    'Untracked content exceeds 16 MiB. Ignore generated artifacts or commit the intended source before verification.', 'SNAPSHOT_LIMIT');
  const content = fs.readFileSync(absolute);
  requireThat(content.length === stat.size, 'A file changed during fingerprinting; retry verification.', 'SOURCE_CHANGED');
  hash.update(`file:${stat.mode & 0o777}:${content.length}:`).update(content).update('\0');
}

// A file's content at a commit, or null when the commit has no such file.
export function fileAt(root, commit, file) {
  relativePath(file);
  return git(root, ['cat-file', 'blob', `${commit}:${file}`], [128]);
}

export function fingerprint(root) {
  requireGitRoot(root);
  checkIndexListing(git(root, ['ls-files', '--stage', '-v', '-z'], [], MAX_LISTING_BYTES));
  const hash = createHash('sha256');
  const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD'], [1]);
  hash.update(head ?? 'unborn');
  const common = ['--binary', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none'];
  // A combined diff against HEAD can hide staged changes reversed in the worktree.
  hash.update('index\0').update(git(root, ['diff', '--cached', ...common, ...EXCLUDE_STATE]));
  hash.update('worktree\0').update(git(root, ['diff', ...common, ...EXCLUDE_STATE]));
  const files = untracked(root);
  requireThat(files.length <= MAX_UNTRACKED_FILES, 'Too many untracked files for verification.', 'INVENTORY_LIMIT');
  const budget = { bytes: 0 };
  for (const file of files) hashFile(hash, root, file, budget);
  // An ignored .npmrc or conftest.py changes what a check runs without changing any Git-visible file.
  hash.update('ignored-definitions\0');
  for (const file of ignoredDefinitionFiles(root)) hashFile(hash, root, file, budget);
  const config = safePath(root, CONFIG_FILE);
  requireThat(fs.statSync(config).size <= 256 * 1024, 'Configuration is too large.');
  hash.update(fs.readFileSync(config));
  return hash.digest('hex');
}
