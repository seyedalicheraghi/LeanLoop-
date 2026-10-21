import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  CONFIG_FILE, STATE_DIR, atomicJson, inspectLock, integer, readJson, relativePath,
  requireThat, safePath, text, withLock,
} from './io.mjs';
import { DEFAULT_TEST_PATHS, ESCALATION_KINDS, globPattern, validateConfig, validateTask } from './schema.mjs';
import { changedSince, fingerprint, headCommit } from './git.mjs';
import { runCheck } from './checks.mjs';

const TASK_FILE = `${STATE_DIR}/task.json`;
const now = () => new Date().toISOString();
export const configFor = root => validateConfig(readJson(root, CONFIG_FILE));
export const taskFor = root => validateTask(readJson(root, TASK_FILE));
const configDigest = config => createHash('sha256')
  .update(JSON.stringify({ checks: config.checks, testPaths: config.testPaths ?? null })).digest('hex');
const MAX_HISTORY = 100;

// Agents under pressure edit or delete tests and weaken checks (SOURCES.md); such changes need a separate review.
export function integrity(root, task, config) {
  if (!task.base) return { available: false, reason: 'The task started before LeanLoop 0.5.0 recorded a base.' };
  if (task.base.head === null) return { available: false, reason: 'No commit existed when the task started.' };
  const patterns = (config.testPaths ?? DEFAULT_TEST_PATHS).map(globPattern);
  const testFiles = changedSince(root, task.base.head).filter(item => patterns.some(pattern => pattern.test(item.path)));
  const checkConfigChanged = configDigest(config) !== task.base.configDigest;
  return {
    available: true, testFileCount: testFiles.length, testFiles: testFiles.slice(0, 20), checkConfigChanged,
    reviewRequired: testFiles.length > 0 || checkConfigChanged,
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
    const task = {
      version: 1, id: randomUUID(), goal: goal.trim(), owner: owner.trim(), risk, scope,
      phase: 'active', acceptance, attempts: 0, attemptLimit: config.attemptLimit,
      checkpoints: [], budgetChanges: [], verification: null, review: null, history: [],
      baseline, base: { head: headCommit(root), configDigest: configDigest(config) }, createdAt: now(), updatedAt: now(),
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
    // A check that failed earlier in this task and passes on the current source: observed red, then green.
    observedFailToPass: current === null || task.verification?.fingerprint !== current ? [] :
      task.verification.results.filter(result => result.ok &&
        (task.history ?? []).some(entry => entry.name === result.name && !entry.ok)).map(result => result.name),
    escalation: task.escalation ?? null,
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
    requireThat(task.attempts < task.attemptLimit,
      'Check attempt budget exhausted. Stop retrying: escalate with what you tried, or extend only for a concrete new hypothesis.', 'BUDGET_EXHAUSTED');
    const checks = config.checks.filter(check => !selectedNames.length || selectedNames.includes(check.name));
    const before = fingerprint(root);
    const previous = task.verification?.fingerprint === before ? task.verification.results : [];
    const results = previous.filter(result => !checks.some(check => check.name === result.name));
    task.attempts += 1;
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
      task.phase = ok ? 'active' : 'blocked';
      delete task.activePid;
      task.verification = stable ? { fingerprint: after, at: now(), results } : null;
      save(root, task);
      return {
        ok, selectionPassed, allChecksPassed: ok && pendingChecks.length === 0,
        knownFailing, pendingChecks, sourceStable: stable,
        attempts: task.attempts, attemptLimit: task.attemptLimit,
        results: executed,
        notRun: checks.filter(check => !executed.some(result => result.name === check.name)).map(check => check.name),
        message: stable ? 'Exit status and configured output assertions recorded; acceptance evidence is still required.' :
          'Git-visible source changed while checks ran. Evidence was invalidated; inspect the changes and rerun.',
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
      const files = checks.testFiles.map(item => `${item.status} ${item.path}`).join(', ') + (checks.testFileCount > 20 ? ', ...' : '');
      requireThat(task.review?.decision === 'approve' && task.review.fingerprint === current,
        `Tests or check configuration changed during this task${files ? ` (${files})` : ''}` +
        `${checks.checkConfigChanged ? ' (leanloop.json checks or testPaths)' : ''}. ` +
        'Get an independent review of those changes, then record it with review.', 'INTEGRITY_REVIEW_REQUIRED');
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
