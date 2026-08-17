import { describe, expect, it, vi } from 'vitest';

// Version resolution talks to Forge's and NeoForge's promotion APIs. Mocked so
// these stay offline like the rest of the suite — what is under test is what
// the installer *does* with a resolved build, not the resolving.
// Partial, not wholesale: the version comparison helpers in this module are
// also what java.ts uses to pick a JDK, and stubbing those out would quietly
// break the very assertion these tests exist to make.
vi.mock('../packages/adapters/src/minecraft/versions.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveForgeDownload: async (version: string, build?: string) => ({
    url: `https://maven.minecraftforge.net/forge-${version}-${build}-installer.jar`,
    fileName: `forge-${version}-${build}-installer.jar`,
    build: build ?? 'recommended',
  }),
  resolveNeoForgeDownload: async (version: string, build?: string) => ({
    url: `https://maven.neoforged.net/neoforge-${build}-installer.jar`,
    fileName: `neoforge-${build}-installer.jar`,
    build: build ?? 'latest',
  }),
}));

const { installCustomPack, readPackVariables } = await import(
  '../packages/adapters/src/minecraft/modpacks.js'
);
const { normaliseLoaderEntryPoint } = await import(
  '../packages/adapters/src/minecraft/index.js'
);

/**
 * A server pack on disk, in memory. `installCustomPack` only ever reaches the
 * filesystem through InstallTools, so a map of paths is a complete stand-in.
 */
function fakePack(files: Record<string, string>) {
  const present = new Set(Object.keys(files));
  const downloads: { url: string; dest: string }[] = [];
  const containerRuns: string[][] = [];
  const detected: { javaMajor?: number; version?: string }[] = [];
  const images: string[] = [];

  const tools = {
    exists: async (p: string) => present.has(p),
    readFile: async (p: string) => files[p] ?? null,
    listDir: async () => [...present].filter((p) => !p.includes('/')),
    download: async (url: string, dest: string) => {
      downloads.push({ url, dest });
      present.add(dest);
      return 1;
    },
    unzip: async () => undefined,
    remove: async (p: string) => void present.delete(p),
    mkdir: async () => undefined,
    writeFile: async () => undefined,
    runInContainer: async ({ image, command }: { image: string; command: string[] }) => {
      images.push(image);
      containerRuns.push(command);
      return { exitCode: 0, output: '' };
    },
  };

  const report = {
    phase: async () => undefined,
    log: async () => undefined,
    runtime: async (d: { javaMajor?: number; version?: string }) => void detected.push(d),
  };

  return { tools, report, downloads, containerRuns, detected, images };
}

const VARIABLES = 'MINECRAFT_VERSION=1.20.1\nMODLOADER=Forge\nMODLOADER_VERSION=47.4.20\n';

/** The shape that used to install "successfully" and then fail to start. */
const SERVER_PACK = {
  'variables.txt': VARIABLES,
  'start.sh': '#!/usr/bin/env bash',
  'mods': '',
  '.serverforge/pack.zip': '',
};

describe('curseforge server packs', () => {
  it('reads the loader and version out of variables.txt', async () => {
    const { tools } = fakePack({ 'variables.txt': VARIABLES });

    expect(await readPackVariables(tools as never)).toEqual({
      minecraftVersion: '1.20.1',
      modloader: 'Forge',
      modloaderVersion: '47.4.20',
    });
  });

  it('ignores a variables.txt that names no loader', async () => {
    const { tools } = fakePack({ 'variables.txt': 'JAVA_ARGS="-Xmx4G"\n' });
    expect(await readPackVariables(tools as never)).toBeNull();
  });

  it('installs the loader and leaves a launchable server.jar', async () => {
    const { tools, report, downloads, containerRuns, images } = fakePack(SERVER_PACK);

    await installCustomPack({ settings: {} } as never, tools as never, report as never);

    // The loader installer runs first: it writes run.sh, which is the only
    // reason the launcher below can start with no arguments.
    expect(containerRuns).toHaveLength(1);
    expect(containerRuns[0]).toContain('--installServer');
    expect(containerRuns[0]!.join(' ')).toContain('forge-1.20.1-47.4.20-installer.jar');

    // Forge 1.20.1 needs Java 17 — including for the installer itself.
    expect(images[0]).toBe('eclipse-temurin:17-jre-jammy');

    // Then the launcher, named server.jar because that is the fixed entry
    // point the panel starts.
    expect(downloads).toHaveLength(2);
    expect(downloads[1]!.dest).toBe('server.jar');
    expect(downloads[1]!.url).toContain('ServerStarterJar');
  });

  it('records the pack version so startup picks the right JDK', async () => {
    const { tools, report, detected } = fakePack(SERVER_PACK);

    await installCustomPack({ settings: {} } as never, tools as never, report as never);

    // Without this the server keeps `from-pack`, and startup's fallback guess
    // of 1.21 selects Java 21 — which will not run a 1.20.1 Forge pack.
    expect(detected).toEqual([{ version: '1.20.1', javaMajor: 17 }]);
  });

  it('fails with the pack contents when there is nothing to launch', async () => {
    const { tools, report } = fakePack({
      'readme.txt': 'client pack',
      '.serverforge/pack.zip': '',
    });

    // Loudly at install time, rather than "Unable to access jarfile
    // server.jar" from the container minutes later.
    await expect(
      installCustomPack({ settings: {} } as never, tools as never, report as never),
    ).rejects.toThrow(/nothing to launch[\s\S]*readme\.txt/);
  });

  it('leaves a pack that already ships its own server.jar alone', async () => {
    const { tools, report, downloads, containerRuns } = fakePack({
      'server.jar': '',
      'mods': '',
      '.serverforge/pack.zip': '',
    });

    await installCustomPack({ settings: {} } as never, tools as never, report as never);

    expect(downloads).toHaveLength(0);
    expect(containerRuns).toHaveLength(0);
  });
});

describe('forge and neoforge loader normalisation', () => {
  /**
   * A server directory after a loader installer has run. The two shapes below
   * are what Forge actually produced when each was run for real: 1.16.5 leaves
   * a launchable jar in the root, 1.20.1 leaves run.sh and an args file.
   */
  const PRE_117 = {
    'forge-1.16.5-36.2.42.jar': '',
    'minecraft_server.1.16.5.jar': '',
    'libraries': '',
    'eula.txt': '',
  };

  const POST_117 = {
    'run.sh': '',
    'user_jvm_args.txt': '',
    'libraries': '',
    'eula.txt': '',
  };

  function fakeInstalled(files: Record<string, string>) {
    const present = new Set(Object.keys(files));
    const renames: { from: string; to: string }[] = [];
    const downloads: { url: string; dest: string }[] = [];

    const tools = {
      exists: async (p: string) => present.has(p),
      listDir: async () => [...present].filter((p) => !p.includes('/')),
      rename: async (from: string, to: string) => {
        renames.push({ from, to });
        present.delete(from);
        present.add(to);
      },
      download: async (url: string, dest: string) => {
        downloads.push({ url, dest });
        present.add(dest);
        return 1;
      },
      remove: async (p: string) => void present.delete(p),
      readFile: async () => null,
      writeFile: async () => undefined,
      mkdir: async () => undefined,
      unzip: async () => undefined,
      runInContainer: async () => ({ exitCode: 0, output: '' }),
    };

    return { tools, renames, downloads, present };
  }

  it('renames the fat jar a pre-1.17 installer leaves', async () => {
    const { tools, renames, downloads } = fakeInstalled(PRE_117);

    await normaliseLoaderEntryPoint({ variantId: 'forge' } as never, tools as never);

    expect(renames).toEqual([{ from: 'forge-1.16.5-36.2.42.jar', to: 'server.jar' }]);
    // Nothing to fetch: that jar launches on its own.
    expect(downloads).toHaveLength(0);
  });

  it('adds the ServerStarterJar when the installer leaves only run.sh', async () => {
    const { tools, renames, downloads } = fakeInstalled(POST_117);

    await normaliseLoaderEntryPoint({ variantId: 'neoforge' } as never, tools as never);

    // The jar under libraries/ is not self-contained, so there is nothing to
    // rename — the real entry point is an args file run.sh passes to java.
    expect(renames).toHaveLength(0);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.dest).toBe('server.jar');
    expect(downloads[0]!.url).toContain('ServerStarterJar');
  });

  it('leaves an existing server.jar alone', async () => {
    const { tools, renames, downloads } = fakeInstalled({ 'server.jar': '', 'run.sh': '' });

    await normaliseLoaderEntryPoint({ variantId: 'forge' } as never, tools as never);

    expect(renames).toHaveLength(0);
    expect(downloads).toHaveLength(0);
  });

  it('never mistakes the installer jar for the launcher', async () => {
    // The installer is removed before normalising, but a failed cleanup must
    // not leave it to be renamed into the entry point.
    const { tools, renames } = fakeInstalled({
      'forge-1.16.5-36.2.42-installer.jar': '',
      'forge-1.16.5-36.2.42.jar': '',
    });

    await normaliseLoaderEntryPoint({ variantId: 'forge' } as never, tools as never);

    expect(renames).toEqual([{ from: 'forge-1.16.5-36.2.42.jar', to: 'server.jar' }]);
  });

  it('fails loudly when the installer left nothing launchable', async () => {
    const { tools } = fakeInstalled({ 'libraries': '', 'eula.txt': '' });

    await expect(
      normaliseLoaderEntryPoint({ variantId: 'forge' } as never, tools as never),
    ).rejects.toThrow(/nothing to launch[\s\S]*eula\.txt/);
  });
});
