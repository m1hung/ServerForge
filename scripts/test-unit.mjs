#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const output = path.resolve('data/release-tests/unit-result.json');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.rm(output, { force: true });
const code = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--exclude', 'tests/*.integration.test.ts', '--reporter=default', '--reporter=json', `--outputFile=${output}`], { stdio: 'inherit' });
  child.once('error', reject); child.once('exit', resolve);
});
const result = JSON.parse(await fs.readFile(output, 'utf8'));
if (code !== 0 || !result.success || result.numTotalTests === 0 || result.numPendingTests || result.numTodoTests || result.numFailedTests)
  throw new Error('Required unit checks failed, were skipped, or produced no test evidence.');
