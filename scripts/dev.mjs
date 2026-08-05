#!/usr/bin/env node
/**
 * Runs the API and the dashboard together with prefixed, colourised output.
 *
 * A dedicated script rather than `concurrently` keeps the dependency list
 * short and lets us do the one thing that actually matters here: if either
 * process dies, take the other one down too, so `npm run dev` never leaves a
 * half-running stack behind.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  { name: 'api', color: '\x1b[36m', args: ['run', 'dev', '--workspace', '@serverforge/api'] },
  { name: 'web', color: '\x1b[35m', args: ['run', 'dev', '--workspace', '@serverforge/web'] },
];

const RESET = '\x1b[0m';
const children = [];
let shuttingDown = false;

function prefix(name, color, chunk) {
  const label = `${color}${name.padEnd(3)}${RESET} │ `;
  return chunk
    .toString()
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => label + line)
    .join('\n');
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}

for (const target of targets) {
  const child = spawn('npm', target.args, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    const text = prefix(target.name, target.color, chunk);
    if (text) console.log(text);
  });
  child.stderr.on('data', (chunk) => {
    const text = prefix(target.name, target.color, chunk);
    if (text) console.error(text);
  });

  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`\n${target.color}${target.name}${RESET} exited with code ${code}. Stopping everything.\n`);
      shutdown(code ?? 1);
    }
  });

  children.push(child);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('\n  API  http://localhost:8080/health');
console.log('  Web  http://localhost:3000\n');
