import { badRequest, type RuntimeCapabilities, type RuntimePlatform } from '@serverforge/core';
import { runtime } from '../routes/servers.js';
export function gameCompatibility(
  gameId: string,
  capabilities: RuntimeCapabilities,
  selected?: RuntimePlatform,
) {
  const native: RuntimePlatform =
    capabilities.architecture === 'arm64' ? 'linux/arm64' : 'linux/amd64';
  const platform = selected ?? (gameId === 'minecraft-java' ? native : 'linux/amd64');
  if (capabilities.os !== 'linux' || !['amd64', 'arm64'].includes(capabilities.architecture))
    return {
      platform,
      status: 'unsupported' as const,
      reason: 'This game requires a supported Linux-container Docker host.',
    };
  if (gameId !== 'minecraft-java' && platform === 'linux/arm64')
    return {
      platform,
      status: 'unsupported' as const,
      reason:
        'This game adapter has no qualified native ARM64 server runtime. Use an x86-64 host or explicitly test emulation.',
    };
  if (native !== platform)
    return {
      platform,
      status: 'experimental' as const,
      reason:
        'This uses CPU emulation. Game compatibility and performance require real tests on this host.',
    };
  if (platform === 'linux/arm64')
    return {
      platform,
      status: 'experimental' as const,
      reason:
        'Native Java is available on ARM64. Individual loaders and mods still require Apple Silicon qualification.',
    };
  return {
    platform,
    status: 'supported' as const,
    reason:
      'Linux x86-64 runtime. Consult the release qualification report for tested game and loader versions.',
  };
}
export async function selectGamePlatform(gameId: string, environment: Record<string, string> = {}) {
  const selected = environment.SF_RUNTIME_PLATFORM;
  if (selected && !['linux/amd64', 'linux/arm64'].includes(selected))
    throw badRequest('The saved runtime platform is invalid. Choose Linux AMD64 or ARM64.');
  const result = gameCompatibility(
    gameId,
    await runtime.capabilities(),
    selected as RuntimePlatform | undefined,
  );
  if (
    result.status === 'unsupported' ||
    (result.status === 'experimental' && environment.SF_ALLOW_EXPERIMENTAL !== 'true')
  )
    throw badRequest(result.reason);
  return result.platform;
}
