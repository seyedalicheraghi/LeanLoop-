import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  CONFIG_FILE, STATE_DIR, atomicFile, atomicJson, inspectLock, integer, readJson, readOptionalText, relativePath,
  requireThat, safePath, text, withLock,
} from './io.mjs';
import { DEFAULT_TEST_PATHS, ESCALATION_KINDS, globPattern, validateConfig, validateTask } from './schema.mjs';
import {
  changesSince, definitionMatcher, fileAt, fingerprint, headCommit, ignoredDefinitionFiles, projectFiles,
} from './git.mjs';
import { runCheck } from './checks.mjs';

const TASK_FILE = `${STATE_DIR}/task.json`;
const now = () => new Date().toISOString();
export const configFor = root => validateConfig(readJson(root, CONFIG_FILE));
export const taskFor = root => validateTask(readJson(root, TASK_FILE));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const configDigest = config => sha256(JSON.stringify({ checks: config.checks, testPaths: config.testPaths ?? null }));
const MAX_HISTORY = 100;
// Reproducing the red on the unchanged starting source is free this many times; later reruns there are retries.
const FREE_BASELINE_RUNS = 2;
const MAX_MANIFEST_FILES = 5000;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const manifestFile = id => `${STATE_DIR}/manifests/${id}.json`;
const matcher = globs => {
  const patterns = globs.map(glob => globPattern(glob));
  return file => patterns.some(pattern => pattern.test(file));
};
const hashOf = content => content === null ? null : sha256(content);
const outsideScope = (scope, file) => scope.length > 0 && !scope.some(item => file === item || file.startsWith(`${item}/`));
const unresolved = task => Boolean(task.escalation && !task.escalation.resolution);

function currentContent(root, file) {
  const absolute = path.join(root, relativePath(file));
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
  if (stat.isSymbolicLink()) return Buffer.from(`link:${fs.readlinkSync(absolute)}`);
  if (!stat.isFile()) return Buffer.from('non-regular');
  safePath(root, file);
  return fs.readFileSync(absolute);
}

// package.json fields that describe or install the package but cannot change what a check runs. Everything else counts:
// scripts, runner configuration (jest, mocha, ava, c8, nyc, ...), imports, type, and devDependencies.
const PACKAGE_METADATA = new Set([
  'name', 'version', 'description', 'keywords', 'author', 'contributors', 'maintainers', 'license', 'homepage',
  'repository', 'bugs', 'funding', 'private', 'publishConfig', 'files', 'engines', 'os', 'cpu', 'dependencies',
  'peerDependencies', 'peerDependenciesMeta', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies',
]);
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;

// Only what can change a check run counts: package.json without its metadata, and pyproject.toml without its
// [project] and [build-system] tables. Other definition files count whole.
function definitionDigest(file, content) {
  if (content === null) return null;
  const name = path.posix.basename(file).toLowerCase();
  let relevant = content;
  if (name === 'package.json') {
    try {
      const parsed = JSON.parse(content.toString('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const kept = Object.fromEntries(Object.entries(parsed).filter(([key]) => !PACKAGE_METADATA.has(key)));
        relevant = Object.keys(kept).length ? JSON.stringify(sorted(kept)) : null;
      }
    } catch {
      relevant = content;
    }
  } else if (name === 'pyproject.toml') {
    const source = content.toString('utf8');
    // A multiline string can hide a table header, so such files are compared whole.
    if (!/"""|'''/.test(source)) {
      const kept = [];
      let metadata = false;
      for (const line of source.split(/\r?\n/)) {
        const header = /^\s*\[\[?([^\]]*)\]\]?\s*(?:#.*)?$/.exec(line);
        if (header) metadata = /^(?:project|build-system)(?:\.|$)/.test(header[1].replace(/[\s"']/g, ''));
        if (!metadata && line.trim()) kept.push(line.trim());
      }
      relevant = kept.length ? kept.join('\n') : null;
    }
  }
  return relevant === null ? null : sha256(relevant);
}

// Start-time hashes of the given files: with no base commit, every file integrity watches; otherwise the files that
// already differed from HEAD, so changes that predate the task are not charged to it.
function recordManifest(root, id, files, isDefinition, tooMany) {
  if (files.length > MAX_MANIFEST_FILES) return { unavailable: tooMany };
  const entries = files.map(file => {
    const content = currentContent(root, file);
    return [file, hashOf(content), isDefinition(file) ? definitionDigest(file, content) : null];
  });
  const content = JSON.stringify({ version: 1, entries });
  if (Buffer.byteLength(content) > MAX_MANIFEST_BYTES) return { unavailable: 'The start-time manifest exceeded its size limit.' };
  atomicFile(root, manifestFile(id), content);
  return { files: entries.length, digest: sha256(content) };
}

function startManifest(root, id, head, config, scope) {
  const isDefinition = definitionMatcher(config.checks);
  if (head !== null) {
    const files = [...new Set(changesSince(root, head).map(item => item.path))];
    return recordManifest(root, id, files, isDefinition, `More than ${MAX_MANIFEST_FILES} files differed from HEAD at start.`);
  }
  const isTest = matcher(config.testPaths ?? DEFAULT_TEST_PATHS);
  const files = projectFiles(root).filter(file => isTest(file) || isDefinition(file) || outsideScope(scope, file));
  return recordManifest(root, id, files, isDefinition,
    `More than ${MAX_MANIFEST_FILES} test, check-definition, or out-of-scope files existed at start.`);
}

function readManifest(root, task) {
  const recorded = task.base.manifest;
  if (!recorded) return { reason: 'No commit existed when the task started, and the task predates start-time manifests.' };
  if (recorded.unavailable) return { reason: recorded.unavailable };
  try {
    const content = readOptionalText(root, manifestFile(task.id), MAX_MANIFEST_BYTES);
    if (content !== null && sha256(content) === recorded.digest) {
      const { entries } = JSON.parse(content);
      if (Array.isArray(entries) && entries.every(entry => Array.isArray(entry) && typeof entry[0] === 'string')) return { entries };
    }
  } catch {
    // Reported below; a damaged manifest must never read as "nothing changed".
  }
  return { reason: 'The start-time manifest is missing or does not match its recorded digest.' };
}

function compareManifest(root, task, entries, isTest, isDefinition) {
  const changed = [];
  const definitions = [];
  const recorded = new Set();
  for (const [file, raw, definition] of entries) {
    recorded.add(file);
    const content = currentContent(root, file);
    const status = content === null ? 'D' : 'M';
    if (hashOf(content) !== raw) changed.push({ status, path: file });
    if (isDefinition(file) && definitionDigest(file, content) !== definition) definitions.push({ status, path: file });
  }
  for (const file of projectFiles(root).filter(item => !recorded.has(item))) {
    if (outsideScope(task.scope, file)) changed.push({ status: 'A', path: file });
    if (isDefinition(file) && definitionDigest(file, currentContent(root, file)) !== null) definitions.push({ status: 'A', path: file });
  }
  return {
    tests: changed.filter(item => item.status !== 'A' && isTest(item.path)), definitions,
    outOfScope: changed.filter(item => outsideScope(task.scope, item.path)),
  };
}

// Changes since HEAD, minus files whose start-time difference from HEAD the task left untouched.
function compareHead(root, task, isTest, isDefinition) {
  const head = task.base.head;
  const changed = changesSince(root, head);
  // Older tasks recorded no start-time differences; a damaged record charges every difference to the task.
  const manifest = task.base.manifest ? readManifest(root, task) : { entries: [] };
  const atStart = new Map((manifest.entries ?? []).map(([file, raw, definition]) => [file, { raw, definition }]));
  const listed = new Set(changed.map(item => item.path));
  // A file the task returned to its HEAD content was still changed by the task.
  for (const file of atStart.keys()) if (!listed.has(file)) changed.push({ status: 'M', path: file });
  const contents = new Map();
  const contentOf = file => {
    if (!contents.has(file)) contents.set(file, currentContent(root, file));
    return contents.get(file);
  };
  const byTask = [];
  for (const item of changed) {
    const start = atStart.get(item.path);
    if (!start) byTask.push(item);
    else if (hashOf(contentOf(item.path)) !== start.raw) {
      byTask.push({ status: contentOf(item.path) === null ? 'D' : start.raw === null ? 'A' : 'M', path: item.path, start });
    }
  }
  const definitionBefore = item => item.start ? item.start.definition : definitionDigest(item.path, fileAt(root, head, item.path));
  const plain = ({ status, path: file }) => ({ status, path: file });
  return {
    // Additions are not reported: new tests are expected, edited or removed ones need review.
    tests: byTask.filter(item => ['M', 'D', 'T'].includes(item.status) && isTest(item.path)).map(plain),
    definitions: byTask.filter(item => isDefinition(item.path) &&
      definitionBefore(item) !== definitionDigest(item.path, contentOf(item.path))).map(plain),
    outOfScope: byTask.filter(item => outsideScope(task.scope, item.path)).map(plain),
  };
}

const ignoredDefinitionDigests = (root, checks) =>
  ignoredDefinitionFiles(root, checks).map(file => [file, definitionDigest(file, currentContent(root, file))]);

// Git-ignored check definitions (an excluded .npmrc or conftest.py) never show in a diff, so start records them.
function ignoredDefinitionChanges(root, task, checks) {
  const recorded = task.base.ignoredDefinitions;
  if (!recorded) return [];
  const before = new Map(recorded);
  const now = new Map(ignoredDefinitionDigests(root, checks));
  const changes = [];
  for (const [file, digest] of now) {
    if (!before.has(file) && digest !== null) changes.push({ status: 'A', path: file });
    else if (before.has(file) && before.get(file) !== digest) changes.push({ status: 'M', path: file });
  }
  for (const [file, digest] of before) if (!now.has(file) && digest !== null) changes.push({ status: 'D', path: file });
  return changes;
}

// A check that failed and then passed on the same final source was rerun until green, which is not evidence.
function flakyChecks(task) {
  const verified = task.verification;
  if (!verified) return [];
  const source = verified.fingerprint.slice(0, 12);
  return verified.results.filter(result => result.ok && (task.history ?? [])
    .some(entry => entry.name === result.name && !entry.ok && entry.fingerprint === source)).map(result => result.name);
}

// Agents under pressure edit or delete tests, weaken checks, and edit beyond their task (SOURCES.md);
// such changes need a separate review.
export function integrity(root, task, config) {
  if (!task.base) return { available: false, reason: 'The task started before LeanLoop 0.5.0 recorded a base.' };
  const isTest = matcher(config.testPaths ?? DEFAULT_TEST_PATHS);
  const isDefinition = definitionMatcher(config.checks);
  let changes = { tests: [], definitions: [], outOfScope: [] };
  let unavailable = null;
  if (task.base.head !== null) {
    changes = compareHead(root, task, isTest, isDefinition);
  } else {
    const manifest = readManifest(root, task);
    if (manifest.reason) unavailable = manifest.reason;
    else changes = compareManifest(root, task, manifest.entries, isTest, isDefinition);
  }
  const { tests, outOfScope } = changes;
  const definitions = [...changes.definitions, ...ignoredDefinitionChanges(root, task, config.checks)];
  const checkConfigChanged = configDigest(config) !== task.base.configDigest;
  const flaky = flakyChecks(task);
  return {
    available: true, testsAvailable: unavailable === null, ...(unavailable === null ? {} : { reason: unavailable }),
    testFileCount: tests.length, testFiles: tests.slice(0, 20), checkConfigChanged,
    checkDefinitionFileCount: definitions.length, checkDefinitionFiles: definitions.slice(0, 20),
    outOfScopeCount: outOfScope.length, outOfScope: outOfScope.slice(0, 20), flakyChecks: flaky,
    reviewRequired: unavailable !== null || tests.length > 0 || checkConfigChanged || definitions.length > 0 ||
      outOfScope.length > 0 || flaky.length > 0,
  };
}

function active(task) {
  requireThat(['active', 'blocked'].includes(task.phase),
    `Task is ${task.phase}; this operation requires an active or blocked task.`);
}

function save(root, task) {
  task.updatedAt = now();
  validateTask(task);
  atomicJson(root, TASK_FILE, task);
}

export async function startTask(root, { goal, criteria, scope = [], risk = 'normal', owner = 'primary' }) {
  const config = configFor(root);
  text(goal, 'Goal', 1000);
  text(owner, 'Owner', 80);
  requireThat(['normal', 'high'].includes(risk), 'Risk must be normal or high.');
  requireThat(Array.isArray(criteria) && criteria.length > 0 && criteria.length <= 10,
    'Provide 1-10 observable acceptance criteria with --accept.');
  const acceptance = criteria.map(criterion => ({ text: text(criterion, 'Acceptance criterion', 500), evidence: null }));
  requireThat(scope.length <= 20, 'Use at most 20 scope paths.');
  for (const item of scope) relativePath(item, 'Scope');
  return withLock(root, async () => {
    const previous = readJson(root, TASK_FILE, true);
    if (previous) {
      validateTask(previous);
      requireThat(['done', 'cancelled'].includes(previous.phase), 'An unfinished task already exists. Resume it or cancel it with a reason.');
    }
    const baseline = fingerprint(root);
    if (previous) {
      const archive = `${STATE_DIR}/history/${previous.id}.json`;
      requireThat(!fs.existsSync(safePath(root, archive)), 'An archive with this task ID already exists; inspect state before continuing.');
      atomicJson(root, archive, previous);
    }
    const id = randomUUID();
    const head = headCommit(root);
    const task = {
      version: 1, id, goal: goal.trim(), owner: owner.trim(), risk, scope,
      phase: 'active', acceptance, attempts: 0, attemptLimit: config.attemptLimit,
      checkpoints: [], budgetChanges: [], verification: null, review: null, history: [],
      baseline, base: {
        head, configDigest: configDigest(config), manifest: startManifest(root, id, head, config, scope),
        ignoredDefinitions: ignoredDefinitionDigests(root, config.checks),
      },
      createdAt: now(), updatedAt: now(),
    };
    save(root, task);
    return summarize(task);
  });
}

export function summarize(task, current = null) {
  return {
    id: task.id, goal: task.goal, owner: task.owner, risk: task.risk, phase: task.phase,
    attempts: task.attempts, attemptLimit: task.attemptLimit, scope: task.scope,
    acceptance: task.acceptance.map((item, index) => ({
      id: index + 1, text: item.text, recorded: Boolean(item.evidence),
      fresh: current === null ? null : item.evidence?.fingerprint === current,
    })),
    verification: task.verification ? {
      fresh: current === null ? null : task.verification.fingerprint === current,
      results: task.verification.results.map(({ name, ok, elapsedMs, exitCode, timedOut, truncated, stdoutLog, stderrLog }) =>
        ({ name, ok, elapsedMs, exitCode, timedOut, truncated, stdoutLog, stderrLog })),
    } : null,
    review: task.review ? {
      reviewer: task.review.reviewer, decision: task.review.decision,
      fresh: current === null ? null : task.review.fingerprint === current,
    } : null,
    // A check that failed on an earlier source in this task and passes on the current one: observed red, then green.
    // A failure on this same source is a flaky rerun, not a red (see flakyChecks).
    observedFailToPass: current === null || task.verification?.fingerprint !== current ? [] :
      task.verification.results.filter(result => result.ok && (task.history ?? []).some(entry => entry.name === result.name &&
        !entry.ok && entry.fingerprint !== current.slice(0, 12))).map(result => result.name),
    escalation: task.escalation ? { ...task.escalation, resolved: Boolean(task.escalation.resolution) } : null,
    next: task.checkpoints.at(-1) ?? null,
    completedAt: task.completedAt ?? null,
  };
}

export function status(root) {
  const issues = [];
  let config = null;
  try {
    config = configFor(root);
  } catch (error) {
    issues.push({ component: 'configuration', code: error.code, error: error.message });
  }
  const lock = inspectLock(root);
  if (lock?.invalid) issues.push({ component: 'lock', code: 'CORRUPT_DATA', error: lock.error });
  const task = readJson(root, TASK_FILE, true);
  if (!task) return { ok: issues.length === 0, task: null, lock, issues, next: 'Start a task with a goal and acceptance criteria.' };
  validateTask(task);
  if (task.phase === 'checking' && !lock) {
    issues.push({ component: 'task', code: 'STRANDED_CHECK', error: 'Checking state has no lock. Inspect the recorded owner before explicit recovery.' });
  }
  let current = null;
  try {
    current = fingerprint(root);
  } catch (error) {
    issues.push({ component: 'fingerprint', code: error.code, error: error.message });
  }
  let checks = null;
  if (config && ['active', 'blocked'].includes(task.phase)) {
    try {
      checks = integrity(root, task, config);
    } catch (error) {
      issues.push({ component: 'integrity', code: error.code, error: error.message });
    }
  }
  return {
    ok: issues.length === 0, ...summarize(task, current), integrity: checks, lock, issues,
    freshness: { available: current !== null, fingerprint: current },
  };
}

export async function checkpoint(root, summary, next) {
  text(summary, 'Checkpoint summary', 1500);
  text(next, 'Next action', 500);
  return withLock(root, async () => {
    const task = taskFor(root);
    active(task);
    requireThat(task.checkpoints.length < 10, 'Checkpoint budget reached. Finish or split the task instead of growing its context indefinitely.');
    // The summary is a claim; record what the checks actually showed alongside it.
    const lastCheck = task.verification ? {
      fresh: task.verification.fingerprint === fingerprint(root),
      passed: task.verification.results.filter(result => result.ok).map(result => result.name),
      failed: task.verification.results.filter(result => !result.ok).map(result => result.name),
    } : null;
    task.checkpoints.push({ summary, next, lastCheck, at: now() });
    save(root, task);
    return summarize(task);
  });
}

export async function recordProof(root, criterion, evidence) {
  integer(criterion, 'Criterion number', 1, 10);
  text(evidence, 'Evidence', 1500);
  return withLock(root, async () => {
    const task = taskFor(root);
    active(task);
    requireThat(criterion <= task.acceptance.length, 'Unknown acceptance criterion.');
    task.acceptance[criterion - 1].evidence = {
      text: evidence, fingerprint: fingerprint(root), at: now(), kind: 'operator-attestation',
    };
    save(root, task);
    return summarize(task);
  });
}

export async function recordReview(root, reviewer, decision, evidence) {
  text(reviewer, 'Reviewer', 80);
  text(evidence, 'Review evidence', 1500);
  requireThat(['approve', 'request-changes'].includes(decision), 'Review decision must be approve or request-changes.');
  return withLock(root, async () => {
    const task = taskFor(root);
    active(task);
    requireThat(reviewer.trim().toLowerCase() !== task.owner.toLowerCase(),
      'The declared reviewer must differ from the task owner. Reviewer identity is not authenticated by this tool.');
    task.review = { reviewer, decision, evidence, fingerprint: fingerprint(root), at: now(), kind: 'operator-attestation' };
    save(root, task);
    return summarize(task);
  });
}

export async function extendBudget(root, attempts, reason) {
  integer(attempts, 'Additional attempts', 1, 10);
  text(reason, 'Budget reason', 500);
  return withLock(root, async () => {
    const task = taskFor(root);
    active(task);
    requireThat(task.budgetChanges.length < 10 && task.attemptLimit + attempts <= 100, 'Task budget expansion limit reached; split the task.');
    task.attemptLimit += attempts;
    task.budgetChanges.push({ attempts, reason, at: now() });
    save(root, task);
    return summarize(task);
  });
}

export async function verify(root, selectedNames = []) {
  return withLock(root, async () => {
    const config = configFor(root);
    const task = taskFor(root);
    active(task);
    requireThat(config.checks.length > 0, 'No checks configured. Add a real check before claiming verification.', 'NO_CHECKS');
    requireThat(selectedNames.every(name => config.checks.some(check => check.name === name)), 'Unknown --only check name.');
    const before = fingerprint(root);
    // Observing the unchanged starting source (reproducing the red, or confirming a baseline) is not a retry the
    // first FREE_BASELINE_RUNS times; rerunning it beyond that is, so a flaky check cannot be retried for free.
    const baselineRuns = task.baselineRuns ?? 0;
    const charged = before !== task.baseline || baselineRuns >= FREE_BASELINE_RUNS;
    requireThat(!charged || task.attempts < task.attemptLimit,
      'Check attempt budget exhausted. Stop retrying: escalate with what you tried, or extend only for a concrete new hypothesis.', 'BUDGET_EXHAUSTED');
    const checks = config.checks.filter(check => !selectedNames.length || selectedNames.includes(check.name));
    const previous = task.verification?.fingerprint === before ? task.verification.results : [];
    const results = previous.filter(result => !checks.some(check => check.name === result.name));
    if (charged) task.attempts += 1;
    else task.baselineRuns = baselineRuns + 1;
    task.phase = 'checking';
    task.activePid = process.pid;
    task.verification = null;
    save(root, task);
    const runId = randomUUID();
    const executed = [];
    try {
      for (const check of checks) {
        const result = await runCheck(root, check, runId);
        executed.push(result);
        results.push(result);
        task.history = [...(task.history ?? []), {
          name: result.name, ok: result.ok, exitCode: result.exitCode, timedOut: result.timedOut,
          fingerprint: before.slice(0, 12), at: now(),
        }].slice(-MAX_HISTORY);
        if (!result.ok) break;
      }
      const after = fingerprint(root);
      const stable = before === after;
      const selectionPassed = stable && executed.length === checks.length && executed.every(result => result.ok);
      const knownFailing = config.checks.filter(check => results.some(result => result.name === check.name && !result.ok))
        .map(check => check.name);
      const pendingChecks = config.checks.filter(check => !results.some(result => result.name === check.name))
        .map(check => check.name);
      const ok = selectionPassed && knownFailing.length === 0;
      // A passing check does not answer an escalated question; only the user's recorded decision does.
      task.phase = ok && !unresolved(task) ? 'active' : 'blocked';
      delete task.activePid;
      task.verification = stable ? { fingerprint: after, at: now(), results } : null;
      save(root, task);
      return {
        ok, selectionPassed, allChecksPassed: ok && pendingChecks.length === 0,
        knownFailing, pendingChecks, sourceStable: stable,
        attempts: task.attempts, attemptLimit: task.attemptLimit, attemptCharged: charged,
        results: executed,
        notRun: checks.filter(check => !executed.some(result => result.name === check.name)).map(check => check.name),
        message: stable ? 'Exit status and configured output assertions recorded; acceptance evidence is still required.' :
          'Git-visible source or an ignored check definition changed while checks ran. Evidence was invalidated; ' +
          'inspect the changes and rerun.',
      };
    } catch (error) {
      task.phase = 'blocked';
      delete task.activePid;
      task.verification = null;
      save(root, task);
      throw error;
    }
  });
}

export async function finish(root) {
  return withLock(root, async () => {
    const config = configFor(root);
    const task = taskFor(root);
    active(task);
    requireThat(!unresolved(task), `The task is escalated (${task.escalation?.kind}) and waits for the user's decision. ` +
      'Report it to the user; after they decide, record their decision, quoted, with resume --decision. ' +
      'Never record a decision the user did not make.', 'ESCALATED');
    requireThat(config.checks.length > 0, 'Cannot finish without configured checks.', 'NO_CHECKS');
    const current = fingerprint(root);
    requireThat(task.verification?.fingerprint === current,
      'Verification is missing or stale. Run check against the current source.', 'STALE_EVIDENCE');
    requireThat(config.checks.every(check => task.verification.results.some(result => result.name === check.name && result.ok)),
      'Some configured checks have not passed against this source.', 'INCOMPLETE_CHECKS');
    requireThat(task.acceptance.every(item => item.evidence?.fingerprint === current),
      'Every acceptance criterion needs current evidence. Use prove; do not substitute a generic green build.', 'INCOMPLETE_ACCEPTANCE');
    if (task.risk === 'high' || task.review) {
      requireThat(task.review?.decision === 'approve' && task.review.fingerprint === current,
        'A current approving review is required. Review attestations must refer to the final source.', 'REVIEW_REQUIRED');
    }
    const checks = integrity(root, task, config);
    if (checks.reviewRequired) {
      const files = (items, count) => items.map(item => `${item.status} ${item.path}`).join(', ') + (count > 20 ? ', ...' : '');
      const reasons = [
        checks.testsAvailable ? null : `test integrity is unavailable (${checks.reason})`,
        checks.testFileCount ? `tests changed (${files(checks.testFiles, checks.testFileCount)})` : null,
        checks.checkConfigChanged ? 'check configuration changed (leanloop.json checks or testPaths)' : null,
        checks.checkDefinitionFileCount ?
          `check definitions changed (${files(checks.checkDefinitionFiles, checks.checkDefinitionFileCount)})` : null,
        checks.flakyChecks.length ? `checks both failed and passed on this same source (${checks.flakyChecks.join(', ')}); ` +
          'a rerun until green is not evidence' : null,
      ].filter(Boolean);
      const scope = checks.outOfScopeCount ? `files outside the task scope changed (${files(checks.outOfScope, checks.outOfScopeCount)})` : null;
      requireThat(task.review?.decision === 'approve' && task.review.fingerprint === current,
        `Review required: ${[...reasons, scope].filter(Boolean).join('; ')}. ` +
        'Get an independent review of those changes, then record it with review.',
        reasons.length ? 'INTEGRITY_REVIEW_REQUIRED' : 'SCOPE_REVIEW_REQUIRED');
    }
    task.phase = 'done';
    task.completedAt = now();
    save(root, task);
    return {
      ...summarize(task, current), integrity: checks,
      note: 'Completion is local evidence bookkeeping, not proof of correctness or authenticated review.',
    };
  });
}

// A structured stop: hand the decision to the user instead of weakening tests or retrying blindly.
export async function escalate(root, kind, summary, tried, recommendation) {
  requireThat(ESCALATION_KINDS.includes(kind), `Escalation kind must be one of: ${ESCALATION_KINDS.join(', ')}.`);
  text(summary, 'Escalation summary', 1500);
  text(tried, 'Approaches tried', 1500);
  text(recommendation, 'Recommendation', 1000);
  return withLock(root, async () => {
    const task = taskFor(root);
    active(task);
    task.phase = 'blocked';
    task.escalation = { kind, summary, tried, recommendation, at: now() };
    save(root, task);
    return { ...summarize(task), next: 'Report the escalation to the user and wait for their decision.' };
  });
}

// The user's answer to an escalation; the CLI records it but cannot authenticate who decided.
export async function resume(root, decision) {
  text(decision, 'Decision', 1000);
  return withLock(root, async () => {
    const task = taskFor(root);
    active(task);
    requireThat(unresolved(task), 'There is no unresolved escalation to resume.');
    task.escalation.resolution = { decision: decision.trim(), at: now() };
    task.phase = 'active';
    save(root, task);
    return { ...summarize(task), next: 'Continue under the recorded decision; checks, evidence, and reviews still apply.' };
  });
}

export async function cancel(root, reason) {
  text(reason, 'Cancellation reason', 500);
  return withLock(root, async () => {
    const task = taskFor(root);
    active(task);
    task.phase = 'cancelled';
    task.cancellation = { reason, at: now() };
    save(root, task);
    return summarize(task);
  });
}
