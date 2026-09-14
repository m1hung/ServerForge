import { expect, it } from 'vitest';
import { portableGameLink, validateArchivePaths } from '@serverforge/core';

it('preserves portable Steam links and internal hard links', () => {
  const target = portableGameLink('world/.steam/root', '/home/container/.local/share/Steam', 'world');
  expect(target).toBe('../.local/share/Steam');
  expect(() => validateArchivePaths([
    { path: 'world/.steam/root', type: 'SymbolicLink', linkpath: target },
    { path: 'world/.local/share/Steam/proof', type: 'File' },
    { path: 'world/copy', type: 'Link', linkpath: 'world/.local/share/Steam/proof' },
  ])).not.toThrow();
});

it('rejects traversal, cycles, writes through links, and chained dot-dot escapes', () => {
  for (const entries of [
    [{ path: 'a', type: 'SymbolicLink', linkpath: '../outside' }],
    [{ path: 'a', type: 'SymbolicLink', linkpath: '/etc' }],
    [{ path: 'a', type: 'SymbolicLink', linkpath: 'a' }],
    [{ path: 'a', type: 'SymbolicLink', linkpath: 'b' }, { path: 'a/file', type: 'File' }],
    [{ path: 'a', type: 'SymbolicLink', linkpath: 'b/..' }, { path: 'b', type: 'SymbolicLink', linkpath: '.' }],
    [{ path: 'hard', type: 'Link', linkpath: '../outside' }],
    [{ path: 'file', type: 'File' }, { path: 'file', type: 'SymbolicLink', linkpath: 'other' }],
  ]) expect(() => validateArchivePaths(entries)).toThrow();
});
