import { expect, it } from 'vitest';
import { formatBytes } from '../packages/core/src/format';

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
