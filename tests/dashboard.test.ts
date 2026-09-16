import { expect, it, vi } from 'vitest';
import { api, ApiError } from '../apps/web/src/lib/api';
import { formatBytes } from '../packages/core/src/format';
import { scheduleTiming, scheduleCron } from '../apps/web/src/lib/schedule';
import { defaultPreferences, normalizePreferences } from '../apps/web/src/lib/preferences';

it('preserves HTTP failure status for distinct missing-page and retry recovery views', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'That server was not found.' } }), {
        status: 404,
      }),
    );
    await expect(api('/api/servers/missing')).rejects.toMatchObject({
      status: 404,
      message: 'That server was not found.',
    });
    fetch.mockResolvedValueOnce(new Response('proxy unavailable', { status: 503 }));
    await expect(api('/api/servers/unavailable')).rejects.toBeInstanceOf(ApiError);
  } finally {
    fetch.mockRestore();
  }
});

it('loads safe browser preferences, ignores unknown values and bounds favorite storage', () => {
  for (const value of [
    null,
    [],
    'old version',
    { density: 'tiny', theme: '<script>', serverSort: {}, consoleFontSize: -1, favorites: 'bad' },
  ])
    expect(normalizePreferences(value)).toEqual(defaultPreferences);
  expect(
    normalizePreferences({
      density: 'compact',
      theme: 'dark',
      consoleWrap: false,
      consoleFontSize: 17,
      showOverviewSummary: false,
      favorites: ['abc', 'abc', null, '../secret', '<script>', 'xyz'],
    }),
  ).toMatchObject({
    density: 'compact',
    theme: 'dark',
    consoleWrap: false,
    consoleFontSize: 17,
    showOverviewSummary: false,
    favorites: ['abc', 'xyz'],
  });
  expect(
    normalizePreferences({ favorites: Array.from({ length: 1000 }, (_, i) => `server${i}`) })
      .favorites,
  ).toHaveLength(500);
});

it('round-trips simple schedules without interpreting advanced cron expressions', () => {
  for (const [frequency, time, weekday, cron] of [
    ['daily', '04:30', '0', '30 4 * * *'],
    ['weekly', '23:59', '6', '59 23 * * 6'],
    ['hourly', '04:00', '0', '0 * * * *'],
  ]) {
    expect(scheduleCron(frequency!, time!, weekday)).toBe(cron);
    expect(scheduleTiming(cron!)).toMatchObject({ frequency, time, weekday });
  }
  for (const cron of ['*/5 * * * *', '0 4 * * 1-5', '61 25 * * *', null])
    expect(scheduleTiming(cron).frequency).toBe('custom');
  expect(() => scheduleCron('daily', '25:00')).toThrow(/valid schedule/);
});

it('keeps sub-byte network rates in bytes instead of scaling them up', () => {
  expect(formatBytes(0.1)).toBe('0 B');
  expect(formatBytes(0.9)).toBe('1 B');
  expect(formatBytes(1024)).toBe('1.0 KiB');
});
import {
  filterServers,
  joinAddress,
  memoryLabel,
  statusTone,
  sortServers,
  type Server,
} from '../apps/web/src/lib/servers';

it('filters actual server states, searches connection addresses, and handles unlimited resources', () => {
  const base: Server = {
    uid: 'one',
    name: 'Weekend Crew',
    gameId: 'minecraft',
    variantId: 'paper',
    version: 'latest',
    state: 'running',
    memoryMib: 4096,
    cpuCores: 2,
    diskMib: 20480,
    node: { name: 'Local', publicHost: '2001:db8::1' },
    allocations: [{ port: 25565, primary: true, purpose: 'game' }],
  };
  const servers = [
    base,
    { ...base, uid: 'two', name: 'Rust crew', gameId: 'rust', state: 'offline' },
    { ...base, uid: 'three', name: 'Failed install', state: 'install_failed' },
  ];
  expect(
    filterServers(servers, ' CREW ', 'running', 'minecraft').map((server) => server.uid),
  ).toEqual(['one']);
  expect(filterServers(servers, '', 'attention', 'all').map((server) => server.uid)).toEqual([
    'three',
  ]);
  expect(filterServers(servers, '', 'offline', 'minecraft')).toEqual([]);
  expect(filterServers(servers, '25565', 'all', 'all')).toHaveLength(3);
  expect(filterServers(servers, 'missing', 'all', 'all')).toEqual([]);
  expect(sortServers(servers, 'name', []).map((s) => s.uid)).toEqual(['three', 'two', 'one']);
  expect(sortServers(servers, 'favorites', ['one', 'notvisible']).map((s) => s.uid)).toEqual([
    'one',
    'three',
    'two',
  ]);
  expect(sortServers(servers, 'running', [])[0]?.uid).toBe('one');
  expect(sortServers(servers, 'attention', [])[0]?.uid).toBe('three');
  expect(servers.map((s) => s.uid)).toEqual(['one', 'two', 'three']);
  expect(
    filterServers(
      [{ ...base, gameId: 'minecraft-bedrock', description: 'Friends only' }],
      'friends only',
      'all',
      'all',
    ),
  ).toHaveLength(1);
  expect(
    filterServers([{ ...base, gameId: 'minecraft-bedrock' }], 'minecraft bedrock', 'all', 'all'),
  ).toHaveLength(1);
  expect(joinAddress(base)).toBe('[2001:db8::1]:25565');
  expect(joinAddress({ ...base, allocations: [] })).toBeNull();
  expect(joinAddress({ ...base, node: { name: 'Local', publicHost: '[::1]' } })).toBe(
    '[::1]:25565',
  );
  expect(memoryLabel(0)).toBe('Unlimited');
  expect(memoryLabel(4096)).toBe('4 GiB');
  expect(statusTone('install_failed')).toBe('danger');
  expect(statusTone('running')).toBe('success');
  expect(statusTone('starting')).toBe('warning');
});
