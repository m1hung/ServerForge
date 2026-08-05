import type { ConsoleGlossary } from '../types.js';

/**
 * Palworld does not accept typed commands on the dedicated-server stdin that
 * the panel attaches to. Admin actions are done in-game with the admin
 * password, or via the REST API when it is enabled.
 *
 * Entries below are the common in-game chat commands (leading slash required
 * in-game). They are shown for reference and are not insertable into the
 * panel console because they would do nothing there.
 */
export function palworldConsoleGlossary(): ConsoleGlossary {
  return {
    acceptsCommands: false,
    note: 'This panel console shows Palworld’s log only — typed commands are not accepted here. Use these in-game as an admin (AdminPassword in Settings), with a leading slash.',
    commands: [
      {
        category: 'Server',
        command: '/Shutdown [seconds] [message]',
        summary: 'Warn players, then shut the server down. Omit seconds for immediate.',
      },
      {
        category: 'Server',
        command: '/DoExit',
        summary: 'Stop the server process immediately without a countdown.',
      },
      {
        category: 'Server',
        command: '/Save',
        summary: 'Force a world save now.',
      },
      {
        category: 'Server',
        command: '/Broadcast <message>',
        summary: 'Send a message to everyone online.',
      },
      {
        category: 'Players',
        command: '/ShowPlayers',
        summary: 'List players currently on the server.',
      },
      {
        category: 'Players',
        command: '/KickPlayer <steamId>',
        summary: 'Disconnect a player. They can rejoin unless banned.',
      },
      {
        category: 'Players',
        command: '/BanPlayer <steamId>',
        summary: 'Ban a player by Steam ID.',
      },
      {
        category: 'Players',
        command: '/TeleportToPlayer <steamId>',
        summary: 'Teleport yourself to another player.',
      },
      {
        category: 'Players',
        command: '/TeleportToMe <steamId>',
        summary: 'Pull another player to your location.',
      },
      {
        category: 'Info',
        command: '/Info',
        summary: 'Show basic server information.',
      },
    ],
  };
}
