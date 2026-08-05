import type { ConsoleGlossary } from '../types.js';

/**
 * Minecraft Java console commands.
 *
 * Curated for day-to-day hosting — not every vanilla subcommand. Templates use
 * angle brackets for required args and square brackets for optional ones.
 */
export function minecraftConsoleGlossary(): ConsoleGlossary {
  return {
    acceptsCommands: true,
    note: 'Commands go straight to the server. You do not need a leading slash here — type `op Steve`, not `/op Steve`.',
    commands: [
      // ── Server ──────────────────────────────────────────────────────────
      {
        category: 'Server',
        command: 'stop',
        summary: 'Save the world and shut down cleanly. Prefer this over Kill.',
      },
      {
        category: 'Server',
        command: 'save-all',
        summary: 'Write the world to disk immediately without stopping.',
      },
      {
        category: 'Server',
        command: 'save-off',
        summary: 'Pause automatic saving — useful right before a backup.',
      },
      {
        category: 'Server',
        command: 'save-on',
        summary: 'Turn automatic saving back on after save-off.',
      },
      {
        category: 'Server',
        command: 'list',
        summary: 'Show who is online right now.',
      },
      {
        category: 'Server',
        command: 'say <message>',
        summary: 'Broadcast a message to every player as the server.',
      },
      {
        category: 'Server',
        command: 'reload',
        summary: 'Reload datapacks and some configs. Prefer a restart for big changes.',
      },

      // ── Players ─────────────────────────────────────────────────────────
      {
        category: 'Players',
        command: 'op <player>',
        summary: 'Grant operator (admin) powers to a player.',
      },
      {
        category: 'Players',
        command: 'deop <player>',
        summary: 'Remove operator powers from a player.',
      },
      {
        category: 'Players',
        command: 'kick <player> [reason]',
        summary: 'Disconnect a player. They can rejoin unless banned.',
      },
      {
        category: 'Players',
        command: 'ban <player> [reason]',
        summary: 'Permanently block a player by name.',
      },
      {
        category: 'Players',
        command: 'ban-ip <address|player>',
        summary: 'Block by IP address (or resolve from a player name).',
      },
      {
        category: 'Players',
        command: 'pardon <player>',
        summary: 'Lift a name ban so they can join again.',
      },
      {
        category: 'Players',
        command: 'pardon-ip <address>',
        summary: 'Lift an IP ban.',
      },
      {
        category: 'Players',
        command: 'whitelist add <player>',
        summary: 'Allow this player when the whitelist is on.',
      },
      {
        category: 'Players',
        command: 'whitelist remove <player>',
        summary: 'Remove a player from the whitelist.',
      },
      {
        category: 'Players',
        command: 'whitelist list',
        summary: 'Show everyone currently on the whitelist.',
      },
      {
        category: 'Players',
        command: 'whitelist on',
        summary: 'Only whitelisted players may join.',
      },
      {
        category: 'Players',
        command: 'whitelist off',
        summary: 'Anyone can join (unless banned).',
      },

      // ── World ───────────────────────────────────────────────────────────
      {
        category: 'World',
        command: 'time set day',
        summary: 'Set the overworld time to morning.',
      },
      {
        category: 'World',
        command: 'time set night',
        summary: 'Set the overworld time to night.',
      },
      {
        category: 'World',
        command: 'weather clear',
        summary: 'Stop rain and thunder.',
      },
      {
        category: 'World',
        command: 'weather rain',
        summary: 'Start rain.',
      },
      {
        category: 'World',
        command: 'weather thunder',
        summary: 'Start a thunderstorm.',
      },
      {
        category: 'World',
        command: 'difficulty <peaceful|easy|normal|hard>',
        summary: 'Change the difficulty for the whole world.',
      },
      {
        category: 'World',
        command: 'gamemode <survival|creative|adventure|spectator> [player]',
        summary: 'Change a player’s game mode (yourself if no name given).',
      },
      {
        category: 'World',
        command: 'gamerule keepInventory true',
        summary: 'Players keep items on death. Use false to turn it off.',
      },
      {
        category: 'World',
        command: 'gamerule doMobSpawning false',
        summary: 'Stop hostile and peaceful mobs spawning naturally.',
      },
      {
        category: 'World',
        command: 'tp <player> <x> <y> <z>',
        summary: 'Teleport a player to coordinates.',
      },
      {
        category: 'World',
        command: 'tp <player> <target>',
        summary: 'Teleport one player to another.',
      },

      // ── Help ────────────────────────────────────────────────────────────
      {
        category: 'Help',
        command: 'help',
        summary: 'List commands the server knows about.',
      },
      {
        category: 'Help',
        command: 'help <command>',
        summary: 'Show usage for one command.',
      },
    ],
  };
}
