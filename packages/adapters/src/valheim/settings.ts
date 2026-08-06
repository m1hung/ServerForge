import type { SettingsSchema } from '@serverforge/core';
import { steamBranchSettings } from '../util/steamcmd.js';

/**
 * Valheim settings.
 *
 * Unlike Minecraft or Palworld, Valheim has no single config file we can
 * round-trip. Name, world, password and visibility are passed as command-line
 * flags to `start_server.sh`, so every setting below uses an `internal`
 * target and the adapter reads them in `startup()`.
 */
export function valheimSettingsSchema(_variantId: string): SettingsSchema {
  const internal = { kind: 'internal' as const };

  return [
    {
      key: 'ServerName',
      type: 'string',
      label: 'Server name',
      help: 'Shown in the in-game server list. Pick something players will recognise.',
      tier: 'basic',
      group: 'Server',
      default: 'A ServerForge Valheim server',
      maxLength: 64,
      restartRequired: true,
      target: internal,
    },
    {
      key: 'WorldName',
      type: 'string',
      label: 'World name',
      help: 'The save file to load or create. Changing this starts a fresh world — your old one stays on disk under a different name.',
      tier: 'basic',
      group: 'Server',
      default: 'Dedicated',
      maxLength: 64,
      restartRequired: true,
      target: internal,
    },
    {
      key: 'Password',
      type: 'string',
      label: 'Join password',
      help: 'Leave empty for an open server. Players must enter this before joining.',
      tier: 'basic',
      group: 'Server',
      default: '',
      secret: true,
      maxLength: 64,
      restartRequired: true,
      target: internal,
    },
    {
      key: 'Public',
      type: 'boolean',
      label: 'List in the public server browser',
      help: 'Off keeps the server joinable by direct IP but hides it from the in-game list.',
      tier: 'basic',
      group: 'Server',
      default: true,
      restartRequired: true,
      target: internal,
    },
    ...steamBranchSettings(),
  ];
}
