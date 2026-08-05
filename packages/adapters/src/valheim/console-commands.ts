import type { ConsoleGlossary } from '../types.js';

/**
 * Valheim’s dedicated server streams logs to stdout but does not take admin
 * commands on stdin. Day-to-day admin is done in-game (or via BepInEx mods).
 */
export function valheimConsoleGlossary(): ConsoleGlossary {
  return {
    acceptsCommands: false,
    note: 'This panel console shows Valheim’s log only — the dedicated server does not accept typed commands here. Manage the world in-game, or use a BepInEx admin mod if you need remote commands.',
    commands: [
      {
        category: 'In-game',
        command: 'F2',
        summary: 'Open the in-game server browser / info overlay while playing.',
      },
      {
        category: 'In-game',
        command: 'Admin list',
        summary: 'Add Steam IDs to adminlist.txt in the world save folder to grant admin.',
      },
      {
        category: 'In-game',
        command: 'Banned list',
        summary: 'Add Steam IDs to bannedlist.txt in the world save folder to ban players.',
      },
      {
        category: 'In-game',
        command: 'Permitted list',
        summary: 'When using a permitted list, only Steam IDs in permittedlist.txt may join.',
      },
      {
        category: 'Panel',
        command: 'stop (panel)',
        summary: 'Use the Stop button above — Valheim saves on a clean SIGINT shutdown.',
      },
      {
        category: 'Panel',
        command: 'save location',
        summary: 'Worlds live under .config/unity3d/IronGate/Valheim/worlds_local in the server files.',
      },
    ],
  };
}
