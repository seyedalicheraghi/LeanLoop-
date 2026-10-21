import { parseArgs } from 'node:util';
import { WorkflowError, projectRoot, requireThat } from './io.mjs';
import { abandon, accept, merge, prepare, runStatus, startRun, validatePlan, verifyRun } from './swarm.mjs';

const HELP = `leanloop swarm (design A: your Claude Code session leads; LeanLoop never starts model sessions)

  swarm validate PLAN              Check plan.json: ids, owned paths, dependencies, checks, acceptance
  swarm start PLAN                 Validate, then create branch leanloop/swarm/RUN and an integration
                                   worktree under .leanloop/worktrees/RUN/integration from HEAD;
                                   your current branch and checkout are not changed
  swarm prepare RUN PACKAGE        Once its dependencies merged: create the package worktree and branch
                                   from the integration tip and print the worker brief
  swarm accept RUN PACKAGE         Require a done LeanLoop task with fresh evidence in the worktree and
                                   changes only inside the owned paths; then commit on the package branch
  swarm merge RUN PACKAGE          Merge an accepted package (--no-ff) in dependency order, run its checks
                                   and the integration checks; on a conflict or failure, roll back and
                                   mark the package for rework
  swarm verify RUN                 Run the sealed checks in the integration worktree with
                                   LEANLOOP_SEALED_DIR set to .leanloop/sealed in the main checkout
  swarm status [RUN]               List runs, or show one run's packages and next steps
  swarm abandon RUN --reason TEXT  Record the reason, then remove the run's worktrees and branches;
                                   worktrees with uncommitted work are kept until it is committed or discarded

All commands accept --project DIR (defaults to cwd). Output is JSON.
`;

const COMMANDS = {
  validate: { positionals: [1, 1] },
  start: { positionals: [1, 1] },
  prepare: { positionals: [2, 2] },
  accept: { positionals: [2, 2] },
  merge: { positionals: [2, 2] },
  verify: { positionals: [1, 1] },
  status: { positionals: [0, 1] },
  abandon: { positionals: [1, 1], options: { reason: { type: 'string' } } },
};

export async function executeSwarm(argv) {
  if (!argv.length || argv[0] === '--help' || argv[0] === 'help') return { help: HELP };
  const command = argv[0];
  requireThat(Object.hasOwn(COMMANDS, command), `Unknown swarm command: ${command}. Use swarm --help.`);
  const spec = COMMANDS[command];
  const { values, positionals } = parseArgs({
    args: argv.slice(1), allowPositionals: true, strict: true,
    options: { project: { type: 'string' }, help: { type: 'boolean' }, ...(spec.options ?? {}) },
  });
  if (values.help) return { help: HELP };
  const [min, max] = spec.positionals;
  requireThat(positionals.length >= min && positionals.length <= max,
    `swarm ${command} takes ${min === max ? min : `${min}-${max}`} positional argument(s). Use swarm --help.`);
  const root = projectRoot(values.project);
  const [first, second] = positionals;
  if (command === 'validate') return validatePlan(root, first);
  if (command === 'start') return startRun(root, first);
  if (command === 'prepare') return prepare(root, first, second);
  if (command === 'accept') return accept(root, first, second);
  if (command === 'merge') return merge(root, first, second);
  if (command === 'verify') return verifyRun(root, first);
  if (command === 'status') return runStatus(root, first);
  if (command === 'abandon') {
    requireThat(values.reason !== undefined, 'swarm abandon requires --reason TEXT.');
    return abandon(root, first, values.reason);
  }
  throw new WorkflowError('Unimplemented swarm command.');
}

export async function runSwarmCli(argv) {
  try {
    const result = await executeSwarm(argv);
    process.stdout.write(result.help ?? `${JSON.stringify(result)}\n`);
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    const code = error instanceof WorkflowError ? error.code : 'OPERATION_FAILED';
    process.stderr.write(`${JSON.stringify({ ok: false, code, error: error.message })}\n`);
    process.exitCode = 2;
  }
}
