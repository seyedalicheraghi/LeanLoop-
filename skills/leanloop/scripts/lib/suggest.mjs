import { optionalStat, readOptionalText, requireThat, WorkflowError } from './io.mjs';

const readSmall = (root, relative) => readOptionalText(root, relative, 512 * 1024);

function exists(root, relative) {
  const stat = optionalStat(root, relative);
  if (!stat) return false;
  requireThat(stat.isFile(), `Expected a regular file: ${relative}`);
  return true;
}

// Suggestions only: doctor prints them, a person or agent reviews them, and add-check records the chosen ones.
export function suggestChecks(root) {
  const suggestions = [];
  const add = (name, command, why, timeout = 600) => {
    if (!suggestions.some(item => item.name === name)) {
      suggestions.push({ name, command, why, addCheck: `add-check ${name} --timeout ${timeout} -- ${command.join(' ')}` });
    }
  };
  const manifest = readSmall(root, 'package.json');
  if (manifest !== null) {
    let parsed;
    try {
      parsed = JSON.parse(manifest);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new WorkflowError('Invalid JSON in package.json; cannot suggest checks.', 'CORRUPT_DATA');
    }
    requireThat(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'package.json must contain an object.', 'CORRUPT_DATA');
    const scripts = parsed.scripts === undefined ? {} : parsed.scripts;
    requireThat(scripts && typeof scripts === 'object' && !Array.isArray(scripts), 'package.json scripts must be an object.', 'CORRUPT_DATA');
    let runner;
    if (parsed.packageManager !== undefined) {
      requireThat(typeof parsed.packageManager === 'string', 'packageManager must be a string.', 'CORRUPT_DATA');
      runner = /^(npm|pnpm|yarn|bun)@/.exec(parsed.packageManager)?.[1];
      requireThat(runner, 'Unrecognized packageManager; configure checks explicitly rather than guessing.');
    } else {
      const managers = [['pnpm', ['pnpm-lock.yaml']], ['yarn', ['yarn.lock']],
        ['bun', ['bun.lock', 'bun.lockb']], ['npm', ['package-lock.json', 'npm-shrinkwrap.json']]]
        .filter(([, locks]) => locks.some(lock => exists(root, lock))).map(([name]) => name);
      requireThat(managers.length <= 1, 'Conflicting package-manager lockfiles; set packageManager or configure checks explicitly.');
      runner = managers[0] ?? 'npm';
    }
    if (typeof scripts.test === 'string' && scripts.test.trim() && !/no test specified/i.test(scripts.test)) {
      add('test', runner === 'bun' ? ['bun', 'run', 'test'] : [runner, 'test'], 'package.json scripts.test');
    }
    if (typeof scripts.lint === 'string' && scripts.lint.trim()) add('lint', [runner, 'run', 'lint'], 'package.json scripts.lint', 300);
    if (typeof scripts.typecheck === 'string' && scripts.typecheck.trim()) add('typecheck', [runner, 'run', 'typecheck'], 'package.json scripts.typecheck', 300);
  }
  const pyproject = readSmall(root, 'pyproject.toml') ?? '';
  if (/\[tool\.pytest/.test(pyproject) || exists(root, 'pytest.ini') || exists(root, 'conftest.py') ||
      /\[tool:pytest\]/.test(readSmall(root, 'setup.cfg') ?? '') || /\[pytest\]/.test(readSmall(root, 'tox.ini') ?? '')) {
    add('pytest', ['python3', '-m', 'pytest', '-q'], 'pytest configuration');
  }
  if (exists(root, 'Cargo.toml')) add('cargo-test', ['cargo', 'test'], 'Cargo.toml', 1200);
  if (exists(root, 'go.mod')) add('go-test', ['go', 'test', './...'], 'go.mod');
  if (/^test:/m.test(readSmall(root, 'Makefile') ?? '')) add('make-test', ['make', 'test'], 'Makefile test target', 1200);
  if (exists(root, 'MODULE.bazel') || exists(root, 'WORKSPACE') || exists(root, 'WORKSPACE.bazel')) {
    add('bazel-test', ['bazel', 'test', '//path/to:affected_test'], 'Bazel workspace: replace the target with the affected tests, never //... by default', 1800);
  }
  return suggestions;
}
