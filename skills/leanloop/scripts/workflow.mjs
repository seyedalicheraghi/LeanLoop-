#!/usr/bin/env node
import { runCli } from './lib/cli.mjs';

await runCli(process.argv.slice(2));
