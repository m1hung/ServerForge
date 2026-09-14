import { expect, it, vi } from 'vitest';
import type { RuntimeCapabilities } from '@serverforge/core';
const state = vi.hoisted(() => ({ architecture: 'arm64' }));
vi.mock('../apps/api/src/routes/servers.js', () => ({ runtime: { capabilities: async () => ({ os: 'linux', architecture: state.architecture }) } }));
import { gameCompatibility, selectGamePlatform } from '../apps/api/src/services/platform.js';
const capabilities = (architecture: string) => ({ os: 'linux', architecture }) as RuntimeCapabilities;
it('keeps native ARM game support distinct from emulation and refuses unsupported combinations', () => {
  expect(gameCompatibility('minecraft-java', capabilities('arm64'))).toMatchObject({ platform: 'linux/arm64', status: 'experimental' });
  expect(gameCompatibility('valheim', capabilities('arm64'))).toMatchObject({ platform: 'linux/amd64', status: 'experimental' });
  expect(gameCompatibility('palworld', capabilities('arm64'), 'linux/arm64').status).toBe('unsupported');
  expect(gameCompatibility('minecraft-java', capabilities('amd64')).status).toBe('supported');
});
it('requires explicit experimental consent and rejects invalid saved platforms', async () => {
  await expect(selectGamePlatform('valheim')).rejects.toThrow(/emulation/);
  expect(await selectGamePlatform('valheim', { SF_ALLOW_EXPERIMENTAL: 'true' })).toBe('linux/amd64');
  await expect(selectGamePlatform('valheim', { SF_RUNTIME_PLATFORM: 'windows/amd64' })).rejects.toThrow(/invalid/);
  await expect(selectGamePlatform('valheim', { SF_RUNTIME_PLATFORM: 'linux/arm64', SF_ALLOW_EXPERIMENTAL: 'true' })).rejects.toThrow(/no qualified/);
});
