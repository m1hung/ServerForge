#!/usr/bin/env node
/**
 * Cross-platform `rm -rf` for package clean scripts.
 *
 *   node scripts/clean.mjs .next dist "*.tsbuildinfo"
 *
 * Globs are matched against the current working directory only (one path segment).
 */
import fs from "node:fs";
import path from "node:path";

const patterns = process.argv.slice(2);
if (patterns.length === 0) {
  console.error("clean.mjs: pass one or more paths to remove");
  process.exit(1);
}

function matchGlob(name, pattern) {
  // Convert a single-segment glob (`*.tsbuildinfo`) to a RegExp.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(name);
}

function remove(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

for (const pattern of patterns) {
  if (/[*?]/.test(pattern)) {
    const dir = process.cwd();
    for (const entry of fs.readdirSync(dir)) {
      if (matchGlob(entry, pattern)) remove(path.join(dir, entry));
    }
    continue;
  }
  remove(path.resolve(process.cwd(), pattern));
}
