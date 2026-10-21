import fs from 'node:fs';
import { parseArgs } from 'node:util';
import {
  CONFIG_FILE, STATE_DIR, WorkflowError, atomicJson, inspectLock, projectRoot, readJson,
  recoverLock, requireThat, safePath, withLock,
} from './io.mjs';
import { validateConfig } from './schema.mjs';
import { requireGitRoot } from './git.mjs';
import { context } from './context.mjs';
import { audit } from './audit.mjs';
import { forget, learn, listLessons } from './lessons.mjs';
import { suggestChecks } from './suggest.mjs';
import { init } from './init.mjs';
import { PROCESS_CLEANUP } from './checks.mjs';
import {
  cancel, checkpoint, configFor, escalate, extendBudget, finish, recordProof, recordReview,
  resume, startTask, status, taskFor, verify,
} from './tasks.mjs';

const HELP = `leanloop (Node 22+, Git; Linux, macOS, or Windows)

  init [--dry-run]                      Create leanloop.json and ignored .leanloop/ state; never
                                        overwrites; the Claude Code plugin supplies the skills
  add-check NAME [--timeout SECONDS] [--cwd PATH] [--expect-output TEXT] -- EXEC ARGS...
  doctor                                Check readiness; never runs project checks
  audit                                 Measure agent-setup overhead (read-only; any project)
  start GOAL --accept CRITERION... [--scope PATH...] [--risk normal|high] [--owner ID]
  context QUERY [--scope PATH...] [--limit 12]
  checkpoint SUMMARY --next ACTION      Save a compact continuation point
  lessons                               List project lessons (at most 30, 8 KiB)
  learn LESSON --evidence TEXT [--anchor PATH] [--replace ID]
                                        Add or replace one short, evidence-backed lesson;
                                        an anchored lesson is flagged stale if PATH disappears
  forget ID                             Remove a stale lesson
  check [--only NAME...]                 Run configured checks; stop on first failure
  prove NUMBER EVIDENCE                  Record acceptance evidence (an attestation)
  review --by ID --decision approve|request-changes --evidence TEXT
  finish                                Require fresh checks, acceptance, and applicable review;
                                        review applies to high risk, edited tests, changed check
                                        definitions, out-of-scope edits, and flaky checks
  status                                Resume without reading the conversation history
  escalate KIND SUMMARY --tried TEXT --recommend TEXT
                                        Stop and hand a decision to the user. KIND: spec-conflict,
                                        test-conflict, budget-exhausted, missing-access,
                                        unclear-scope, other; finish refuses until resume
  resume --decision TEXT                Record the user's decision on an escalation and reactivate;
                                        quote the user, never decide it yourself
  extend --attempts N --reason TEXT      Explicitly expand the check-attempt budget
  cancel --reason TEXT                  Preserve an unfinished task as cancelled
  recover --owner-pid PID                Remove only a dead owner's lock
  recover --unlocked --reason TEXT       Reset stranded checking state with no lock
  recover --broken-lock --reason TEXT    Explicitly quarantine an invalid owner record

All commands accept --project DIR (defaults to cwd). Output is JSON.
No models, services, hooks, commits, or package downloads are started automatically.
`;

const STRING = { type: 'string' };
const MULTIPLE = { type: 'string', multiple: true };
const OPTIONS = {
  init: { 'dry-run': { type: 'boolean' } },
  'add-check': { timeout: STRING, cwd: STRING, 'expect-output': STRING },
  doctor: {},
  audit: {},
  start: { accept: MULTIPLE, scope: MULTIPLE, risk: STRING, owner: STRING },
  context: { scope: MULTIPLE, limit: STRING },
  checkpoint: { next: STRING },
  lessons: {},
  learn: { evidence: STRING, anchor: STRING, replace: STRING },
  forget: {},
  check: { only: MULTIPLE },
  prove: {},
  review: { by: STRING, decision: STRING, evidence: STRING },
  finish: {},
  status: {},
  escalate: { tried: STRING, recommend: STRING },
  resume: { decision: STRING },
  extend: { attempts: STRING, reason: STRING },
  cancel: { reason: STRING },
  recover: { 'owner-pid': STRING, unlocked: { type: 'boolean' }, 'broken-lock': { type: 'boolean' }, reason: STRING },
};

export async function execute(argv) {
  if (!argv.length || argv[0] === '--help' || argv[0] === 'help') return { help: HELP };
  const command = argv[0];
  requireThat(Object.hasOwn(OPTIONS, command), `Unknown command: ${command}`);
  const rest = argv.slice(1);
  const separator = rest.indexOf('--');
  const commandArgs = command === 'add-check' && separator >= 0 ? rest.slice(separator + 1) : [];
  const parsedArgs = command === 'add-check' && separator >= 0 ? rest.slice(0, separator) : rest;
  const { values, positionals } = parseArgs({
    args: parsedArgs, allowPositionals: true, strict: true,
    options: { project: STRING, help: { type: 'boolean' }, ...OPTIONS[command] },
  });
  if (values.help) return { help: HELP };
  const expected = ['start', 'context', 'checkpoint', 'add-check', 'learn', 'forget'].includes(command) ? 1 : ['prove', 'escalate'].includes(command) ? 2 : 0;
  requireThat(positionals.length === expected, `${command} requires ${expected} positional argument(s). Use --help.`);
  const root = projectRoot(values.project);
  if (command === 'init') {
    return init(root, values['dry-run'] ?? false);
  }
  if (command === 'add-check') {
    requireThat(commandArgs.length > 0, 'Supply an executable argument array after --.');
    return withLock(root, async () => {
      const config = configFor(root);
      const check = { name: positionals[0], command: commandArgs };
      if (values.timeout !== undefined) check.timeoutSeconds = Number(values.timeout);
      if (values.cwd !== undefined) check.cwd = values.cwd;
      if (values['expect-output'] !== undefined) check.expectOutput = values['expect-output'];
      config.checks.push(check);
      validateConfig(config);
      atomicJson(root, CONFIG_FILE, config);
      return { ok: true, check: check.name, message: 'Configuration saved. Review configured commands before running check.' };
    });
  }
  if (command === 'audit') return audit(root);
  if (command === 'status') return status(root);
  const config = configFor(root);
  if (command === 'lessons') return listLessons(root);
  if (command === 'learn') {
    return withLock(root, async () => learn(root, positionals[0], values.evidence,
      values.replace === undefined ? undefined : Number(values.replace), values.anchor));
  }
  if (command === 'forget') return withLock(root, async () => forget(root, Number(positionals[0])));
  if (command === 'doctor') {
    requireGitRoot(root);
    const ignore = safePath(root, `${STATE_DIR}/.gitignore`);
    const stateIgnored = fs.existsSync(ignore) && fs.readFileSync(ignore, 'utf8') === '*\n';
    const lock = inspectLock(root);
    return {
      ok: config.checks.length > 0 && stateIgnored && !lock,
      configuredChecks: config.checks.map(check => check.name), stateIgnored, lock, processCleanup: PROCESS_CLEANUP,
      existingProjectInstructions: ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'].filter(file => fs.existsSync(safePath(root, file))),
      ...(config.checks.length ? {} : {
        suggestedChecks: suggestChecks(root),
        howToAdd: 'Review a suggestion, then run it once by hand; record only real, relevant checks with add-check.',
      }),
      note: 'Existing instructions remain authoritative. Resolve conflicting mandatory role chains before adoption. Commands run with your permissions, not in a sandbox.',
    };
  }
  if (command === 'context') {
    return context(root, positionals[0], values.scope ?? [], values.limit === undefined ? 12 : Number(values.limit));
  }
  if (command === 'start') {
    return startTask(root, {
      goal: positionals[0], criteria: values.accept ?? [], scope: values.scope ?? [],
      risk: values.risk ?? 'normal', owner: values.owner ?? 'primary',
    });
  }
  if (command === 'check') return verify(root, values.only ?? []);
  if (command === 'checkpoint') return checkpoint(root, positionals[0], values.next);
  if (command === 'prove') return recordProof(root, Number(positionals[0]), positionals[1]);
  if (command === 'review') return recordReview(root, values.by, values.decision, values.evidence);
  if (command === 'finish') return finish(root);
  if (command === 'escalate') return escalate(root, positionals[0], positionals[1], values.tried, values.recommend);
  if (command === 'resume') return resume(root, values.decision);
  if (command === 'extend') return extendBudget(root, Number(values.attempts), values.reason);
  if (command === 'cancel') return cancel(root, values.reason);
  if (command === 'recover') {
    const existing = readJson(root, `${STATE_DIR}/task.json`, true);
    const activePid = existing ? taskFor(root).activePid : undefined;
    const recovered = recoverLock(root, {
      ownerPid: values['owner-pid'] === undefined ? undefined : Number(values['owner-pid']),
      unlocked: values.unlocked ?? false, broken: values['broken-lock'] ?? false,
      reason: values.reason, activePid,
    });
    return withLock(root, async () => {
      if (existing) {
        const task = taskFor(root);
        if (task.phase === 'checking') {
          task.phase = 'blocked';
          task.verification = null;
          delete task.activePid;
          task.recovery = { ...recovered, at: new Date().toISOString() };
          task.updatedAt = new Date().toISOString();
          atomicJson(root, `${STATE_DIR}/task.json`, task);
        }
      }
      return { ...recovered, next: 'Inspect any orphaned check processes before rerunning verification.' };
    });
  }
  throw new WorkflowError('Unimplemented command.');
}

export async function runCli(argv) {
  try {
    const result = await execute(argv);
    process.stdout.write(result.help ?? `${JSON.stringify(result)}\n`);
    if (result.ok === false) process.exitCode = result.results?.some(item => item.interrupted) ? 130 : 1;
  } catch (error) {
    const code = error instanceof WorkflowError ? error.code : 'OPERATION_FAILED';
    process.stderr.write(`${JSON.stringify({ ok: false, code, error: error.message })}\n`);
    process.exitCode = 2;
  }
}
