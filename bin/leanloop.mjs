#!/usr/bin/env node
import { install } from '../lib/install.mjs';
import { runCli } from '../skills/leanloop/scripts/lib/cli.mjs';

await runCli(process.argv.slice(2), install);
