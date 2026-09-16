import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultsFor, validateSettings } from '@serverforge/core';
import { bedrockAdapter } from '../packages/adapters/src/bedrock/index.js';
import {
  bedrockDownloadUrl,
  latestBedrock,
  resolveBedrockVersion,
} from '../packages/adapters/src/bedrock/versions.js';
import type { InstallTools, ServerContext } from '../packages/adapters/src/types.js';
import { parseProperties } from '../packages/adapters/src/util/properties.js';
import { forwardablePorts, mapPorts } from '../apps/api/src/services/ports.js';

const schema = bedrockAdapter.settingsSchema('bedrock-vanilla');
const context: ServerContext = {
  serverUid: 'bedrock-test',
  name: 'Bedrock test',
  dataPath: '/fixture',
  version: '1.26.45.1',
  variantId: 'bedrock-vanilla',
  settings: defaultsFor(schema),
  memoryMib: 4096,
  cpuCores: 2,
  allocations: [{ ip: '0.0.0.0', port: 32200, purpose: 'game', primary: true }],
  environment: {},
  javaFlagsPreset: 'balanced',
};

afterEach(() => vi.restoreAllMocks());

function filesFixture(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const tools: InstallTools = {
    download: vi.fn(async () => 100),
    unzip: vi.fn(async () => {
      files.set('bedrock_server', 'official-linux-binary');
      files.set(
        'server.properties',
        '# Publisher comment\nserver-port=19132\nunknown-setting=keep\n',
      );
    }),
    readFile: async (file) => files.get(file) ?? null,
    writeFile: async (file, text) => {
      files.set(file, text);
    },
    exists: async (file) => files.has(file),
    remove: vi.fn(async (file) => {
      files.delete(file);
    }),
    mkdir: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    listDir: async () => ['vanilla', 'vanilla_1.26.40'],
    runInContainer: vi.fn(async () => ({ exitCode: 0, output: '' })),
  };
  return { files, tools };
}

describe('Bedrock installation and connectivity', () => {
  it('installs the pinned official build and records bundled packs separately from user content', async () => {
    const { files, tools } = filesFixture();
    const runtime = vi.fn();
    await bedrockAdapter.install(context, tools, { phase: vi.fn(), log: vi.fn(), runtime });
    expect(tools.download).toHaveBeenCalledWith(
      'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.45.1.zip',
      'bedrock-server.zip',
      expect.any(Object),
    );
    expect(tools.unzip).toHaveBeenCalledWith('bedrock-server.zip', '.');
    expect(tools.remove).toHaveBeenCalledWith('bedrock-server.zip');
    expect(runtime).toHaveBeenCalledWith({ version: '1.26.45.1' });
    expect(files.get('eula.txt')).toContain('eula=true');
    expect(JSON.parse(files.get('.serverforge/bedrock-distribution.json')!)).toContain(
      'behavior_packs/vanilla',
    );
    expect(files.get('server.properties')).toContain('# Publisher comment');
    expect(parseProperties(files.get('server.properties')!)).toMatchObject({
      'server-port': '32200',
      'enable-lan-visibility': 'true',
      transport: 'raknet',
      'allow-list': 'true',
      'online-mode': 'true',
      'unknown-setting': 'keep',
    });
  });
  it('fails an incomplete ZIP before reporting success', async () => {
    const { tools } = filesFixture();
    tools.unzip = async () => {};
    await expect(
      bedrockAdapter.install(context, tools, { phase: vi.fn(), log: vi.fn() }),
    ).rejects.toThrow(/does not contain/);
  });
  it('publishes and forwards only the allocated UDP game endpoint, with no RCON or extra default host ports', () => {
    expect(bedrockAdapter.requiredPorts('bedrock-vanilla')).toEqual([
      { purpose: 'game', protocol: 'udp' },
    ]);
    const plan = bedrockAdapter.startup(context);
    const expected = [
      { hostIp: '0.0.0.0', hostPort: 32200, containerPort: 32200, protocol: 'udp' },
    ];
    expect(mapPorts(plan.ports, context.allocations)).toEqual(expected);
    expect(forwardablePorts(plan.ports, context.allocations)).toEqual(expected);
    expect(plan.command).toEqual(['./bedrock_server']);
    expect(plan.entrypoint).toEqual([]);
    expect(plan.env.LD_LIBRARY_PATH).toBe('.');
    expect(plan.stopCommand).toBe('stop\n');
    expect(plan.console).toBeUndefined();
  });
  it('requires a game allocation rather than silently starting on the wrong port', async () => {
    await expect(
      bedrockAdapter.applySettings({ ...context, allocations: [] }, filesFixture().tools),
    ).rejects.toThrow(/allocated UDP/);
  });
});

describe('Bedrock versions and configuration', () => {
  it('selects the stable Linux download rather than Windows or Preview', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({
        result: {
          links: [
            { downloadType: 'serverBedrockWindows', downloadUrl: 'windows.zip' },
            { downloadType: 'serverBedrockPreviewLinux', downloadUrl: 'preview.zip' },
            { downloadType: 'serverBedrockLinux', downloadUrl: bedrockDownloadUrl('1.26.45.1') },
          ],
        },
      }),
    );
    expect(await latestBedrock()).toMatchObject({ id: '1.26.45.1', stable: true });
    expect(await resolveBedrockVersion('latest')).toMatchObject({ id: '1.26.45.1' });
  });
  it('refuses an unexpected publisher download origin', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        result: {
          links: [
            {
              downloadType: 'serverBedrockLinux',
              downloadUrl: 'https://example.com/bedrock-server-1.26.45.1.zip',
            },
          ],
        },
      }),
    );
    await expect(latestBedrock()).rejects.toThrow(/official Linux Bedrock download/);
  });
  it.each([
    '1.21.1',
    '../../worlds',
    '1.26.45.1?url=http://localhost',
    'https://example.com/server.zip',
  ])('rejects Java versions and untrusted download input: %s', async (version) => {
    await expect(resolveBedrockVersion(version)).rejects.toThrow();
    expect(() => bedrockDownloadUrl(version)).toThrow();
  });
  it('validates Bedrock-specific settings and rejects traversal and injected property lines', () => {
    expect(validateSettings(schema, defaultsFor(schema)).ok).toBe(true);
    for (const name of [
      '../world',
      '..',
      '/tmp/world',
      'world\\outside',
      'world\nallow-list=false',
    ])
      expect(validateSettings(schema, { 'level-name': name }).ok).toBe(false);
    expect(validateSettings(schema, { 'server-name': 'Hello\nallow-list=false' }).ok).toBe(false);
    expect(validateSettings(schema, { 'level-seed': 'seed\\nallow-list=false' }).ok).toBe(false);
    expect(
      validateSettings(schema, { 'level-name': 'Our Bedrock World', 'tick-distance': 12 }).ok,
    ).toBe(true);
    expect(validateSettings(schema, { 'tick-distance': 3 }).ok).toBe(false);
    expect(validateSettings(schema, { 'rcon.password': 'java-only' }).ok).toBe(false);
  });
});

it('recognizes Bedrock readiness and gamertags with spaces, and offers only Bedrock console commands', () => {
  expect(
    bedrockAdapter.inspectLog?.('[2026-09-15 12:00:00:000 INFO] Server started.'),
  ).toMatchObject({ ready: true });
  for (const [word, type] of [
    ['connected', 'join'],
    ['disconnected', 'leave'],
  ])
    expect(
      bedrockAdapter.inspectLog?.(
        `[2026-09-15 12:00:00:000 INFO] Player ${word}: Alex Bedrock, xuid: 12345, pfid: abc`,
      ),
    ).toMatchObject({ playerEvent: { type, name: 'Alex Bedrock' } });
  const commands = bedrockAdapter.consoleGlossary!('bedrock-vanilla').commands.map(
    (item) => item.command,
  );
  expect(commands).toContain('allowlist add "<gamertag>"');
  expect(commands).not.toContain('save-all');
  expect(commands).not.toContain('ban <player> [reason]');
  expect(bedrockAdapter.inspectLog?.('Some unrelated line')).toBeNull();
});
