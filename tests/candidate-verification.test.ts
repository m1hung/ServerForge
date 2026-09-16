import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { verifyCandidate } from '../scripts/lib/verify-candidate.mjs';

it('verifies archive contents and rejects corruption and mismatched image evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-bundle-'));
  const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
  try {
    const directory = path.join(root, 'bundle'); await fs.mkdir(path.join(directory, 'security'), { recursive: true });
    const source = path.join(root, 'source'); await fs.mkdir(path.join(source, 'release'), { recursive: true });
    const release = '0.1.0-rc.2', revision = 'a'.repeat(40);
    const sourceFiles = [];
    for (const [name, text] of [['release/serverforge', 'launcher'], ['release.json', JSON.stringify({ version: release })], ['release/security-exceptions.json', '[]']]) {
      await fs.writeFile(path.join(source, name), text); sourceFiles.push({ path: name, mode: '100644', sha256: hash(text) });
    }
    await tar.c({ cwd: source, file: path.join(directory, 'source.tar.gz'), gzip: true, portable: true }, ['.']);
    await fs.copyFile(path.join(source, 'release/serverforge'), path.join(directory, 'serverforge'));
    await fs.copyFile(path.join(source, 'release.json'), path.join(directory, 'release.json'));
    await fs.writeFile(path.join(directory, 'security/reviewed-findings.json'), '[]');
    await fs.writeFile(path.join(directory, 'source-files.json'), JSON.stringify(sourceFiles));
    const imageRoot = path.join(root, 'images'); await fs.mkdir(imageRoot);
    const images = [], saved = [], scans = [];
    for (const component of ['api', 'web', 'maintenance', 'postgres', 'tailscale']) {
      const config = JSON.stringify({ architecture: 'amd64', os: 'linux', config: { Labels: { component, 'org.opencontainers.image.version': release, 'org.opencontainers.image.revision': revision } } });
      const digest = hash(config), reference = `serverforge-${component}:${release}`;
      await fs.writeFile(path.join(imageRoot, `${digest}.json`), config);
      images.push({ component, reference, digest: `sha256:${digest}` }); saved.push({ Config: `${digest}.json`, RepoTags: [reference], Layers: [] });
      scans.push({ image: component, digest: `sha256:${digest}`, architecture: 'amd64', database: { status: { valid: true } }, unreviewed: [] });
      for (const kind of ['sbom', 'scan']) await fs.writeFile(path.join(directory, `security/${component}.${kind}.json`), '{}');
    }
    await fs.writeFile(path.join(imageRoot, 'manifest.json'), JSON.stringify(saved));
    await tar.c({ cwd: imageRoot, file: path.join(directory, 'serverforge-images.tar'), portable: true }, ['.']);
    await fs.writeFile(path.join(directory, 'security/result.json'), JSON.stringify({ format: 'serverforge-image-security', ok: true, images: scans }));
    const manifest = { format: 'serverforge-tester-bundle', version: 1, release, architecture: 'amd64', sourceRevision: revision, sourceDigest: hash(JSON.stringify(sourceFiles)), images };
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    const checksums = async () => {
      const names = (await fs.readdir(directory, { recursive: true })).filter((name) => name !== 'SHA256SUMS');
      const lines = [];
      for (const name of names) if ((await fs.stat(path.join(directory, name))).isFile()) lines.push(`${hash(await fs.readFile(path.join(directory, name)))}  ${name}`);
      await fs.writeFile(path.join(directory, 'SHA256SUMS'), lines.join('\n') + '\n');
    };
    await checksums(); expect((await verifyCandidate(directory)).ok).toBe(true);
    // Docker Desktop's containerd store uses the OCI manifest ID, whereas
    // the classic Docker store uses the config ID verified above.
    const oci = JSON.stringify({ schemaVersion: 2, config: { digest: images[0].digest }, layers: [] });
    const ociDigest = hash(oci);
    await fs.mkdir(path.join(imageRoot, 'blobs/sha256'), { recursive: true });
    await fs.writeFile(path.join(imageRoot, 'blobs/sha256', ociDigest), oci);
    images[0].digest = `sha256:${ociDigest}`; scans[0].digest = images[0].digest;
    await tar.c({ cwd: imageRoot, file: path.join(directory, 'serverforge-images.tar'), portable: true }, ['.']);
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(directory, 'security/result.json'), JSON.stringify({ format: 'serverforge-image-security', ok: true, images: scans }));
    await checksums(); expect((await verifyCandidate(directory)).ok).toBe(true);
    await fs.writeFile(path.join(directory, 'serverforge'), 'tampered');
    await expect(verifyCandidate(directory)).rejects.toThrow(/Checksum mismatch/);
    await fs.writeFile(path.join(directory, 'serverforge'), 'launcher');
    manifest.images[0].digest = `sha256:${'f'.repeat(64)}`;
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest)); await checksums();
    await expect(verifyCandidate(directory)).rejects.toThrow(/Packaged image mismatch/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
