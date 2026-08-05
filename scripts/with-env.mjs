#!/usr/bin/env node
/**
 * Runs a command with the repo-root `.env` loaded.
 *
 * Workspace scripts execute with their own package as the cwd, and tools like
 * the Prisma CLI only look for `.env` next to themselves. Rather than asking
 * people to keep a second copy of their configuration in `packages/db`, this
 * wrapper is invoked with Node's own `--env-file-if-exists` (see the scripts
 * in packages/db/package.json) and simply passes the resulting environment on.
 *
 * Using Node's parser rather than a hand-rolled one matters: it handles
 * quoting, escapes and multi-line values the same way `node --env-file` does
 * everywhere else in this project.
 *
 *   node --env-file-if-exists=../../.env ../../scripts/with-env.mjs prisma db push
 */
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error('with-env.mjs: no command given');
  process.exit(1);
}

// npm puts node_modules/.bin on PATH for scripts, so `prisma` resolves without
// a shell — which keeps arguments from being re-interpreted.
const child = spawn(command, args, { stdio: 'inherit', env: process.env });

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(`with-env.mjs: could not run ${command}: ${error.message}`);
  process.exit(1);
});
