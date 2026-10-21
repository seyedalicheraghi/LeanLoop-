#!/usr/bin/env node
const argv = process.argv.slice(2);

if (argv[0] === 'swarm') {
  const { runSwarmCli } = await import('./lib/swarm-cli.mjs');
  await runSwarmCli(argv.slice(1));
} else {
  const { runCli } = await import('./lib/cli.mjs');
  await runCli(argv);
}
