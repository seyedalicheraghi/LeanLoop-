import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { ensureDirectory, requireThat, safePath } from './io.mjs';
import { projectEnvironment } from './git.mjs';

export const MAX_LOG_BYTES = 64 * 1024;
const ELISION = Buffer.from('\n... [output truncated; head and tail retained] ...\n');
const HEAD_BYTES = Math.floor((MAX_LOG_BYTES - ELISION.length) / 2);
const TAIL_BYTES = MAX_LOG_BYTES - ELISION.length - HEAD_BYTES;

function capture(needle) {
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let carry = Buffer.alloc(0);
  let total = 0;
  let matched = needle.length === 0;
  return {
    push(chunk) {
      total += chunk.length;
      if (head.length < HEAD_BYTES) {
        head = Buffer.concat([head, chunk.subarray(0, HEAD_BYTES - head.length)]);
      }
      tail = Buffer.from(Buffer.concat([tail, chunk]).subarray(-TAIL_BYTES));
      if (!matched) {
        const window = Buffer.concat([carry, chunk]);
        matched = window.includes(needle);
        carry = matched || needle.length === 1 ? Buffer.alloc(0) :
          Buffer.from(window.subarray(-(needle.length - 1)));
      }
    },
    get truncated() { return total > HEAD_BYTES + TAIL_BYTES; },
    get matched() { return matched; },
    get bytes() { return total; },
    render() {
      if (total <= HEAD_BYTES) return head;
      if (total <= HEAD_BYTES + TAIL_BYTES) {
        return Buffer.concat([head, tail.subarray(tail.length - (total - head.length))]);
      }
      return Buffer.concat([head, ELISION, tail]);
    },
  };
}

export async function runCheck(root, check, runId) {
  requireThat(process.platform !== 'win32',
    'Process-group verification currently supports Linux and macOS. Windows verification is not supported.');
  const cwd = check.cwd && check.cwd !== '.' ? safePath(root, check.cwd) : root;
  requireThat(fs.statSync(cwd).isDirectory(), `Check cwd is not a directory: ${check.cwd}`);
  const logDirectory = `.leanloop/logs/${runId}`;
  ensureDirectory(root, logDirectory);
  const stdoutLog = `${logDirectory}/${check.name}.stdout.log`;
  const stderrLog = `${logDirectory}/${check.name}.stderr.log`;
  const opened = [];
  const needle = Buffer.from(check.expectOutput ?? '');
  const captures = { stdout: capture(needle), stderr: capture(needle) };
  let removedEnvironment = [];
  let timedOut = false;
  let interrupted = null;
  let spawnError = null;
  let cleanupError = null;
  let outputError = null;
  let exitCode = null;
  let signal = null;
  let child;
  let timeout;
  let forceKill;
  const started = performance.now();

  function signalGroup(name) {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if (error.code !== 'ESRCH') cleanupError = error.message;
    }
  }

  function stop() {
    signalGroup('SIGTERM');
    if (!forceKill) forceKill = setTimeout(() => signalGroup('SIGKILL'), 100);
  }

  function onInterrupt(name) {
    interrupted = name;
    stop();
  }
  const onSigint = () => onInterrupt('SIGINT');
  const onSigterm = () => onInterrupt('SIGTERM');

  try {
    const descriptors = {};
    for (const [stream, file] of [['stdout', stdoutLog], ['stderr', stderrLog]]) {
      descriptors[stream] = fs.openSync(safePath(root, file), 'wx', 0o600);
      opened.push({ stream, fd: descriptors[stream] });
    }
    const { env, removed } = projectEnvironment();
    removedEnvironment = removed;
    // A check is independent, not a child test file of a caller's Node runner.
    if (Object.hasOwn(env, 'NODE_TEST_CONTEXT')) removedEnvironment.push('NODE_TEST_CONTEXT');
    delete env.NODE_TEST_CONTEXT;
    child = spawn(check.command[0], check.command.slice(1), {
      cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', chunk => {
        captures[stream].push(chunk);
      });
    }
    child.on('error', error => { spawnError = error.message; });
    timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, (check.timeoutSeconds ?? 120) * 1000);
    await new Promise(resolve => {
      child.once('close', (code, closeSignal) => {
        exitCode = code;
        signal = closeSignal;
        resolve();
      });
    });
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceKill);
    signalGroup('SIGTERM');
    if (child?.pid) {
      await wait(110);
      signalGroup('SIGKILL');
    }
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    for (const { stream, fd } of opened) {
      try {
        fs.writeFileSync(fd, captures[stream].render());
      } catch (error) {
        outputError = error.message;
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  const expectedOutputFound = captures.stdout.matched || captures.stderr.matched;
  const truncated = captures.stdout.truncated || captures.stderr.truncated;
  return {
    name: check.name,
    ok: exitCode === 0 && !timedOut && !interrupted && !spawnError && !cleanupError && !outputError && expectedOutputFound,
    exitCode, signal, timedOut, interrupted, spawnError, cleanupError, outputError, expectedOutputFound, truncated,
    streamBytes: { stdout: captures.stdout.bytes, stderr: captures.stderr.bytes }, removedEnvironment,
    elapsedMs: Math.round(performance.now() - started),
    stdoutLog, stderrLog,
  };
}
