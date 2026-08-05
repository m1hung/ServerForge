#!/usr/bin/env node
/**
 * Runs `next` with WEB_PORT so scripts work under cmd.exe and PowerShell
 * (bash-style `${WEB_PORT:-3000}` is not expanded there).
 *
 *   node scripts/run-web.mjs dev
 *   node scripts/run-web.mjs start
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "dev";
if (mode !== "dev" && mode !== "start") {
  console.error(`run-web.mjs: expected "dev" or "start", got "${mode}"`);
  process.exit(1);
}

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "apps",
  "web",
);
const port = process.env.WEB_PORT?.trim() || "3000";
const require = createRequire(path.join(webRoot, "package.json"));
const nextCli = path.join(
  path.dirname(require.resolve("next/package.json")),
  "dist",
  "bin",
  "next",
);

const child = spawn(process.execPath, [nextCli, mode, "-p", port], {
  cwd: webRoot,
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(`run-web.mjs: could not run next: ${error.message}`);
  process.exit(1);
});
