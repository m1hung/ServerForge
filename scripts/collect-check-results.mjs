#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'data/release-tests');
const destination = path.join(root, 'data/check-results');
await fs.mkdir(destination, { recursive: true, mode: 0o700 });

// Recovery fixtures contain private, container-owned directories. Collect only
// known report files, never recursively glob the installation or its secrets.
for (const entry of await fs.readdir(source, { withFileTypes: true }).catch((error) => {
  if (error.code === 'ENOENT') return [];
  throw error;
})) {
  if (!entry.isDirectory()) continue;
  const reports = entry.name === 'image-scans-current'
    ? (await fs.readdir(path.join(source, entry.name))).filter((file) => /^(result|[a-z0-9-]+\.(sbom|scan))\.json$/.test(file))
    : /^(serverforge-test-|serverforge-packaged-)/.test(entry.name)
      ? ['result.json', 'recovery-result.json']
      : [];
  for (const report of reports) {
    const target = path.join(destination, entry.name);
    try {
      const contents = await fs.readFile(path.join(source, entry.name, report));
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(target, report), contents, { mode: 0o600 });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
