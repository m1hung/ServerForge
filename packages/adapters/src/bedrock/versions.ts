import { AppError, badRequest, fetchJson } from '@serverforge/core';
import type { VersionInfo } from '../types.js';

const LINKS = 'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links';
const PREFIX = 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-';
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Mojang lists the current stable build, not a supported historical archive. */
export async function latestBedrock(): Promise<VersionInfo> {
  const metadata = await fetchJson<{
    result?: { links?: { downloadType: string; downloadUrl: string }[] };
  }>(LINKS, { service: 'Minecraft Bedrock' });
  const links = metadata?.result?.links;
  const url = Array.isArray(links)
    ? links.find((link) => link?.downloadType === 'serverBedrockLinux')?.downloadUrl
    : undefined;
  const version =
    typeof url === 'string' && url.startsWith(PREFIX) && url.endsWith('.zip')
      ? url.slice(PREFIX.length, -4)
      : '';
  if (!VERSION.test(version))
    throw new AppError(
      502,
      'upstream_failure',
      'The official Linux Bedrock download is missing or has an unrecognized format. Check the Minecraft download page and try again later.',
    );
  return { id: version, label: version, stable: true };
}

export async function resolveBedrockVersion(version: string): Promise<VersionInfo> {
  if (version === 'latest') return latestBedrock();
  if (!VERSION.test(version))
    throw badRequest(
      'Choose a Bedrock server build, such as 1.26.45.1. Java Edition versions cannot be used here.',
    );
  return { id: version, label: version, stable: true };
}

export function bedrockDownloadUrl(version: string): string {
  if (!VERSION.test(version)) throw badRequest('Invalid Bedrock server build.');
  return `${PREFIX}${version}.zip`;
}
