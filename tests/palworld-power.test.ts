import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ content: '', inContainer: true }));
vi.mock('../apps/api/src/services/file-manager.js', () => ({ readTextFile: async () => ({ content: state.content }) }));
vi.mock('../apps/api/src/lib/storage-paths.js', () => ({ localDataPath: (value: string) => value }));
vi.mock('../apps/api/src/lib/config.js', () => ({ config: { brand: { resourcePrefix: 'fixture' } }, runningInContainer: () => state.inContainer }));
import { stopPalworld } from '../apps/api/src/services/palworld-power.js';
const server = { uid: 'test', dataPath: '/fixture/test', containerId: 'owned', allocations: [{ purpose: 'rest', port: 32502 }] };
afterEach(() => vi.unstubAllGlobals());
it('uses applied credentials and the private allocated endpoint, saves before shutdown, then verifies clean exit', async () => {
  state.content = '[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(AdminPassword="applied-secret",RESTAPIEnabled=True,RESTAPIPort=32502)';
  const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  await stopPalworld(server, { status: async () => ({ exists: true, running: false, exitCode: 0, oomKilled: false }) });
  expect(fetcher.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['http://fixture-test:32502/v1/api/save', 'http://fixture-test:32502/v1/api/shutdown']);
  const options = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect(options.redirect).toBe('error');
  expect((options.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('admin:applied-secret').toString('base64')}`);
});
it('refuses missing credentials and mismatched ports before any request', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  state.content = '[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(AdminPassword="",RESTAPIEnabled=True,RESTAPIPort=32502)';
  await expect(stopPalworld(server, { status: vi.fn() })).rejects.toThrow('admin password');
  state.content = state.content.replace('AdminPassword=""', 'AdminPassword="secret"').replace('32502', '8080');
  await expect(stopPalworld(server, { status: vi.fn() })).rejects.toThrow('admin password');
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not attempt shutdown after a rejected save or accept a signal/OOM exit as clean', async () => {
  state.content = '[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(AdminPassword="secret",RESTAPIEnabled=True,RESTAPIPort=32502)';
  const fetcher = vi.fn(async () => new Response('{}', { status: 401 })); vi.stubGlobal('fetch', fetcher);
  await expect(stopPalworld(server, { status: vi.fn() })).rejects.toThrow('refused save');
  expect(fetcher).toHaveBeenCalledTimes(1);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  await expect(stopPalworld(server, { status: async () => ({ exists: true, running: false, exitCode: 137, oomKilled: true }) })).rejects.toThrow('abnormally');
});
