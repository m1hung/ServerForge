import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as tar from 'tar';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const safe = (name) => name && !path.isAbsolute(name) && !name.split('/').includes('..') && !/[\r\n\t\\]/.test(name);
async function files(root, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = path.posix.join(prefix, entry.name);
    if (!safe(name)) throw new Error('Unsafe bundle path.');
    if (entry.isDirectory()) result.push(...await files(root, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error('Bundle links and special files are forbidden.');
  }
  return result;
}
async function archive(file, selected) {
  const values = new Map();
  await tar.t({ file, onReadEntry(entry) {
    const name = entry.path.replace(/^\.\//, '');
    if (entry.type === 'Directory' && (name === '' || safe(name))) return;
    if (entry.type !== 'File' || !safe(name)) throw new Error('Unsafe archive entry.');
    if (!selected(name)) return;
    if (values.has(name)) throw new Error('Duplicate archive entry.');
    if (entry.size > 32 * 1024 ** 2) throw new Error('Oversized source/config entry.');
    const chunks = []; values.set(name, null);
    entry.on('data', (data) => chunks.push(data));
    entry.on('end', () => values.set(name, Buffer.concat(chunks)));
  } });
  return values;
}

export async function verifyCandidate(directory) {
  const sums = new Map();
  for (const line of (await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8')).trim().split('\n')) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match || !safe(match[2]) || sums.has(match[2]) || match[2] === 'SHA256SUMS') throw new Error('Invalid checksum manifest.');
    sums.set(match[2], match[1]);
  }
  const actual = (await files(directory)).filter((name) => name !== 'SHA256SUMS');
  if (actual.length !== sums.size || actual.some((name) => !sums.has(name))) throw new Error('Bundle contains missing or unlisted files.');
  for (const name of actual) {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path.join(directory, name))) hash.update(bytes);
    if (hash.digest('hex') !== sums.get(name)) throw new Error(`Checksum mismatch: ${name}`);
  }
  const json = async (name) => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
  const manifest = await json('manifest.json'), release = await json('release.json'), sourceFiles = await json('source-files.json');
  if (manifest.format !== 'serverforge-tester-bundle' || manifest.version !== 1 || manifest.release !== release.version || !/^[a-f0-9]{40}$/.test(manifest.sourceRevision) || !['amd64', 'arm64'].includes(manifest.architecture) || digest(JSON.stringify(sourceFiles)) !== manifest.sourceDigest)
    throw new Error('Candidate/source manifest mismatch.');
  const source = await archive(path.join(directory, 'source.tar.gz'), () => true);
  if (source.size !== sourceFiles.length) throw new Error('Source archive file list mismatch.');
  for (const file of sourceFiles) if (!source.has(file.path) || digest(source.get(file.path)) !== file.sha256) throw new Error(`Source archive mismatch: ${file.path}`);
  for (const [target, original] of [['serverforge', 'release/serverforge'], ['release.json', 'release.json'], ['security/reviewed-findings.json', 'release/security-exceptions.json']])
    if (!source.get(original)?.equals(await fs.readFile(path.join(directory, target)))) throw new Error(`Bundled source mismatch: ${target}`);
  const imageArchive = path.join(directory, 'serverforge-images.tar');
  const header = await archive(imageArchive, (name) => name === 'manifest.json');
  const saved = JSON.parse(header.get('manifest.json')?.toString() || 'null');
  if (!Array.isArray(saved) || saved.length !== 5 || manifest.images?.length !== 5) throw new Error('Expected exactly five candidate images.');
  const configs = await archive(imageArchive, (name) => saved.some((image) => image.Config === name));
  const security = await json('security/result.json');
  if (security.format !== 'serverforge-image-security' || security.ok !== true || security.images?.length !== 5) throw new Error('Candidate image security evidence is incomplete.');
  for (const component of ['api', 'web', 'maintenance', 'postgres', 'tailscale']) {
    const image = manifest.images.find((entry) => entry.component === component);
    const savedImage = image && saved.find((entry) => entry.RepoTags?.includes(image.reference));
    const bytes = savedImage && configs.get(savedImage.Config);
    if (!bytes || `sha256:${digest(bytes)}` !== image.digest) throw new Error(`Packaged image mismatch: ${component}`);
    const config = JSON.parse(bytes.toString());
    if (config.architecture !== manifest.architecture || config.os !== 'linux' || config.config.Labels?.['org.opencontainers.image.version'] !== manifest.release || config.config.Labels?.['org.opencontainers.image.revision'] !== manifest.sourceRevision)
      throw new Error(`Packaged image architecture/version mismatch: ${component}`);
    const scan = security.images.find((entry) => entry.image === component);
    if (scan?.digest !== image.digest || scan.architecture !== manifest.architecture || scan.unreviewed?.length !== 0 || scan.database?.status?.valid !== true || !sums.has(`security/${component}.sbom.json`) || !sums.has(`security/${component}.scan.json`)) throw new Error(`Candidate scan mismatch: ${component}`);
  }
  return { ok: true, release: manifest.release, architecture: manifest.architecture, sourceRevision: manifest.sourceRevision, sourceDigest: manifest.sourceDigest, images: manifest.images.map(({ component, digest }) => ({ component, digest })) };
}
