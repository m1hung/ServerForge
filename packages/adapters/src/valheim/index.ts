import type {
  GameAdapter,
  GameVariant,
  InstallTools,
  LogInsight,
  ServerContext,
  StartupPlan,
  VersionInfo,
} from '../types.js';
import { STEAMCMD_IMAGE, steamAppUpdate } from '../util/steamcmd.js';
import { valheimConsoleGlossary } from './console-commands.js';
import { valheimSettingsSchema } from './settings.js';

/**
 * Valheim dedicated server.
 *
 * Installed through SteamCMD (app 896660) and launched via the shipped
 * `start_server.sh` wrapper. Settings are command-line flags rather than a
 * config file, so `applySettings` is mostly a no-op and `startup()` reads
 * values straight from `ctx.settings`.
 */

const STEAM_APP_ID = '896660';

const VARIANTS: GameVariant[] = [
  {
    id: 'valheim-vanilla',
    name: 'Valheim',
    summary: 'The official dedicated server, straight from Steam.',
    detail:
      'Everything the game ships with, kept up to date from Steam. Choose this unless you specifically want mods.',
    order: 1,
    recommended: true,
    supportsMods: false,
    modLoader: 'none',
  },
  {
    id: 'valheim-bepinex',
    name: 'Valheim + BepInEx',
    summary: 'Same server, with a BepInEx plugins folder set up for you.',
    detail:
      'BepInEx is the mod loader most Valheim server mods are built for. We create the folder structure and explain how to upload mods — BepInEx itself is not bundled, because its releases track game patches and a mismatched build crashes on boot with no useful error.',
    order: 2,
    tags: ['Mods', 'Advanced'],
    supportsMods: true,
    modLoader: 'none',
  },
];

export const valheimAdapter: GameAdapter = {
  id: 'valheim',
  name: 'Valheim',
  summary: 'Co-op viking survival. Up to 10 players.',
  icon: 'Axe',
  variants: VARIANTS,

  defaultLimits() {
    // Valheim is lighter than Palworld but still needs headroom for world
    // generation and a full group exploring at once.
    return { memoryMib: 4096, cpuCores: 2, diskMib: 10240 };
  },

  requiredPorts() {
    return [
      { purpose: 'game', protocol: 'udp' },
      { purpose: 'query', protocol: 'udp' },
    ];
  },

  settingsSchema(variantId) {
    return valheimSettingsSchema(variantId);
  },

  async listVersions(): Promise<VersionInfo[]> {
    return [{ id: 'latest', label: 'Latest (kept up to date from Steam)', stable: true }];
  },

  async resolveVersion(): Promise<VersionInfo> {
    return { id: 'latest', label: 'Latest', stable: true };
  },

  async install(ctx, tools, report) {
    await report.phase('preparing', 'Creating the server folder…', 5);
    await tools.mkdir('.');

    await report.phase(
      'downloading',
      'Downloading Valheim from Steam — this is a few GB and takes a while…',
      15,
    );

    await steamAppUpdate(tools, {
      appId: STEAM_APP_ID,
      validate: true,
      report: (msg) => report.log(msg),
    });

    if (ctx.variantId === 'valheim-bepinex') {
      await report.phase('extracting', 'Setting up the BepInEx plugins folder…', 85);
      await setupModLoader(tools);
    }

    await report.phase('configuring', 'Writing your settings…', 92);
    await this.applySettings(ctx, tools);

    await report.phase('finalizing', 'Ready to start.', 100);
  },

  async applySettings(_ctx, _tools) {
    // Valheim reads name, world, password and visibility from launch flags.
    // Nothing to materialise on disk — `startup()` applies them each boot.
  },

  startup(ctx): StartupPlan {
    const game = ctx.allocations.find((a) => a.purpose === 'game') ?? ctx.allocations[0];
    const gamePort = game?.port ?? 2456;

    const serverName = String(ctx.settings.ServerName ?? 'A ServerForge Valheim server');
    const worldName = String(ctx.settings.WorldName ?? 'Dedicated');
    const password = String(ctx.settings.Password ?? '');
    const isPublic = ctx.settings.Public !== false;

    const args = [
      '-name',
      serverName,
      '-port',
      String(gamePort),
      '-world',
      worldName,
      '-public',
      isPublic ? '1' : '0',
    ];

    if (password) {
      args.push('-password', password);
    }

    return {
      image: STEAMCMD_IMAGE,
      command: ['./start_server.sh', ...args],
      workingDir: '/home/container',
      env: {
        ...ctx.environment,
        LD_LIBRARY_PATH: '/home/container/linux64:/home/container/steamclient',
        TZ: ctx.environment.TZ ?? 'UTC',
      },
      ports: [
        { containerPort: 2456, purpose: 'game', protocol: 'udp' },
        { containerPort: 2457, purpose: 'query', protocol: 'udp' },
      ],
      // Valheim has no stdin shutdown command. SIGINT triggers a clean save.
      stopTimeoutSeconds: 60,
      readyPattern: 'Game server connected',
    };
  },

  reportsPlayers: true,

  inspectLog(line): LogInsight | null {
    if (/Game server connected/i.test(line)) {
      return { level: 'success', ready: true, hint: 'Server is accepting players.' };
    }
    if (/Failed to bind|Address already in use|bind\(\) failed/i.test(line)) {
      return {
        level: 'error',
        hint: 'Another program is using this port. Change the port under Network and start again.',
      };
    }
    if (/out of memory|Killed process/i.test(line)) {
      return {
        level: 'error',
        hint: 'Valheim ran out of memory. Try raising the memory limit, or ask fewer players to explore different areas at once.',
      };
    }
    // "Got character ZDOID from Erik : 1234567890:1" — ZDOID is a literal
    // token, so the name is the part *after* "from", up to the id suffix.
    // The guard and the extraction must agree on case or the branch is entered
    // and then silently produces nothing.
    {
      const match = /got character\s+\S+\s+from\s+(.+?)(?:\s+:\s|\s*$)/i.exec(line);
      if (match?.[1]) {
        return { level: 'info', playerEvent: { type: 'join', name: match[1].trim() } };
      }
    }
    if (/Closing connection to .+/i.test(line)) {
      const match = /Closing connection to (.+)/i.exec(line);
      if (match?.[1]) {
        return { level: 'info', playerEvent: { type: 'leave', name: match[1] } };
      }
    }
    if (/Error:|Fatal|ERROR/i.test(line)) return { level: 'error' };
    if (/Warning:|WARN/i.test(line)) return { level: 'warn' };
    return null;
  },

  modDirectory(variantId) {
    return variantId === 'valheim-bepinex' ? 'BepInEx/plugins' : null;
  },

  consoleGlossary() {
    return valheimConsoleGlossary();
  },
};

/**
 * Lays out the directories BepInEx expects and leaves a README explaining
 * the upload workflow. We create the structure rather than downloading
 * BepInEx automatically: its releases are not versioned against Valheim
 * builds, and silently shipping a mismatched loader produces a server that
 * crashes on boot with no explanation.
 */
async function setupModLoader(tools: InstallTools): Promise<void> {
  await tools.mkdir('BepInEx/plugins');

  await tools.writeFile(
    'BepInEx/plugins/README.txt',
    [
      'Drop BepInEx plugin .dll files in this folder.',
      '',
      'Each plugin is usually one .dll. Remove a file to disable that mod.',
      'The Mods tab in the panel manages this folder for you, including',
      'enabling and disabling without deleting anything.',
      '',
      'BepInEx itself is not bundled: its releases track Valheim patches,',
      'not ServerForge updates, and an incompatible build crashes the server',
      'at boot. Download the BepInEx release that matches your current',
      'Valheim version from the BepInEx project and upload it into the',
      'server root (alongside start_server.sh).',
      '',
      'After a Valheim update, check BepInEx and your plugins still match',
      'before starting.',
    ].join('\n'),
  );
}

export { valheimSettingsSchema };
