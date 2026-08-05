import type {
  GameAdapter,
  GameVariant,
  InstallTools,
  LogInsight,
  ServerContext,
  StartupPlan,
  VersionInfo,
} from '../types.js';
import { parseIni, parseTuple, quoteUnreal, stringifyIni, stringifyTuple, unrealBool, unrealFloat } from '../util/ini.js';
import { STEAMCMD_IMAGE, steamAppUpdate } from '../util/steamcmd.js';
import { palworldSettingsSchema } from './settings.js';

/**
 * Palworld dedicated server.
 *
 * Installed through SteamCMD (app 2394010) in a throwaway container, then
 * run from the same directory. Palworld has no official Workshop support for
 * dedicated servers, so the modded variant sets up UE4SS plus a managed
 * `~mods` directory and treats mods as files — which is what the community
 * actually does, and is honest about what it is.
 */

const STEAM_APP_ID = '2394010';
/** Palworld ships as a 64-bit Linux binary needing the Steam runtime libs. */
const RUNTIME_IMAGE = STEAMCMD_IMAGE;

const CONFIG_PATH = 'Pal/Saved/Config/LinuxServer/PalWorldSettings.ini';
const CONFIG_SECTION = '/Script/Pal.PalGameWorldSettings';

const VARIANTS: GameVariant[] = [
  {
    id: 'palworld-vanilla',
    name: 'Palworld',
    summary: 'The official dedicated server, straight from Steam.',
    detail:
      'Everything the game ships with, kept up to date from Steam. Choose this unless you specifically want mods.',
    order: 1,
    recommended: true,
    supportsMods: false,
    modLoader: 'none',
  },
  {
    id: 'palworld-modded',
    name: 'Palworld + mods',
    summary: 'Same server, with the UE4SS mod loader set up for you.',
    detail:
      'Palworld has no official mod support on dedicated servers. We install UE4SS — the loader nearly every Palworld mod is built against — and give you a managed mods folder. Mods are added by uploading their files; there is no in-game browser, because Palworld does not provide one. Every player usually needs the same mods installed locally too.',
    order: 2,
    tags: ['Mods', 'Advanced'],
    supportsMods: true,
    modLoader: 'none',
  },
];

export const palworldAdapter: GameAdapter = {
  id: 'palworld',
  name: 'Palworld',
  summary: 'Open-world survival with creature collecting. Up to 32 players.',
  icon: 'PawPrint',
  variants: VARIANTS,

  defaultLimits() {
    // Palworld's floor is genuinely high — under 8 GB it will crash under
    // load, and telling someone that after their world corrupts is too late.
    return { memoryMib: 16384, cpuCores: 4, diskMib: 30720 };
  },

  requiredPorts() {
    return [
      { purpose: 'game', protocol: 'udp' },
      { purpose: 'query', protocol: 'udp' },
      { purpose: 'rest', protocol: 'tcp' },
    ];
  },

  settingsSchema(variantId) {
    return palworldSettingsSchema(variantId);
  },

  async listVersions(): Promise<VersionInfo[]> {
    // Steam only ever serves the current build of the public branch.
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
      'Downloading Palworld from Steam — this is around 8 GB and takes a while…',
      15,
    );

    await steamAppUpdate(tools, {
      appId: STEAM_APP_ID,
      validate: true,
      report: (msg) => report.log(msg),
    });

    await report.phase('configuring', 'Preparing the configuration…', 70);
    await tools.mkdir('Pal/Saved/Config/LinuxServer');

    // Palworld only writes PalWorldSettings.ini on first boot, and boots with
    // defaults if it is missing. Seeding it from the shipped defaults means
    // the user's wizard choices apply to the very first world, not the second.
    const defaults = await tools.readFile('DefaultPalWorldSettings.ini');
    if (defaults && !(await tools.exists(CONFIG_PATH))) {
      await tools.writeFile(CONFIG_PATH, defaults);
    }

    if (ctx.variantId === 'palworld-modded' && ctx.settings.sf_enable_ue4ss !== false) {
      await report.phase('extracting', 'Setting up the UE4SS mod loader…', 85);
      await setupModLoader(tools);
    }

    await report.phase('configuring', 'Writing your settings…', 92);
    await this.applySettings(ctx, tools);

    await report.phase('finalizing', 'Ready to start.', 100);
  },

  async applySettings(ctx, tools) {
    const schema = palworldSettingsSchema(ctx.variantId);

    const existing = await tools.readFile(CONFIG_PATH);
    const sections = existing ? parseIni(existing) : {};
    sections[CONFIG_SECTION] ??= {};

    const currentTuple = sections[CONFIG_SECTION]!['OptionSettings'];
    const options = currentTuple ? parseTuple(currentTuple) : {};

    for (const setting of schema) {
      if (setting.target.kind !== 'ini') continue;
      const value = ctx.settings[setting.key];
      if (value === undefined) continue;

      switch (setting.type) {
        case 'boolean':
          options[setting.target.key] = unrealBool(Boolean(value));
          break;
        case 'number':
          // Unreal distinguishes int and float fields; rate-style settings
          // declare a step, integers do not.
          options[setting.target.key] = setting.step
            ? unrealFloat(Number(value))
            : String(Math.round(Number(value)));
          break;
        case 'enum':
          options[setting.target.key] = String(value);
          break;
        case 'string':
          options[setting.target.key] = quoteUnreal(String(value));
          break;
      }
    }

    const game = ctx.allocations.find((a) => a.purpose === 'game') ?? ctx.allocations[0];
    const rest = ctx.allocations.find((a) => a.purpose === 'rest');
    if (game) options['PublicPort'] = String(game.port);
    if (rest) options['RESTAPIPort'] = String(rest.port);

    sections[CONFIG_SECTION]!['OptionSettings'] = stringifyTuple(options);
    await tools.writeFile(CONFIG_PATH, stringifyIni(sections));
  },

  startup(ctx): StartupPlan {
    const game = ctx.allocations.find((a) => a.purpose === 'game') ?? ctx.allocations[0];
    const query = ctx.allocations.find((a) => a.purpose === 'query');
    const maxPlayers = Number(ctx.settings.ServerPlayerMaxNum ?? 16);

    const args = [
      `-port=${game?.port ?? 8211}`,
      `-queryport=${query?.port ?? 27015}`,
      `-players=${maxPlayers}`,
      '-publiclobby=false',
      '-NoAsyncLoadingThread',
    ];

    if (ctx.settings.sf_use_perf_threads !== false) {
      args.push('-useperfthreads', '-UseMultithreadForDS');
    }

    return {
      image: RUNTIME_IMAGE,
      command: ['./PalServer.sh', ...args],
      workingDir: '/home/container',
      env: {
        ...ctx.environment,
        // The shipped launcher resolves Steam libraries relative to itself.
        LD_LIBRARY_PATH: '/home/container/linux64:/home/container/steamclient',
        TZ: ctx.environment.TZ ?? 'UTC',
      },
      ports: [
        { containerPort: 8211, purpose: 'game', protocol: 'udp' },
        { containerPort: 27015, purpose: 'query', protocol: 'udp' },
        { containerPort: 8212, purpose: 'rest', protocol: 'tcp' },
      ],
      // Palworld has no console command interface on stdin. SIGINT triggers
      // its clean shutdown path, which flushes the world save.
      stopTimeoutSeconds: 60,
      readyPattern: 'Setting breakpad minidump AppID|Running Palworld dedicated server',
    };
  },

  inspectLog(line): LogInsight | null {
    if (/Running Palworld dedicated server/i.test(line)) {
      return { level: 'success', ready: true, hint: 'Server is accepting players.' };
    }
    if (/Setting breakpad minidump AppID = 2394010/.test(line)) {
      return { level: 'info', ready: true };
    }
    if (/Failed to bind|Address already in use/i.test(line)) {
      return {
        level: 'error',
        hint: 'Another program is using this port. Change the port under Network and start again.',
      };
    }
    if (/out of memory|Killed process/i.test(line)) {
      return {
        level: 'error',
        hint: 'Palworld ran out of memory. It needs at least 8 GB, and about 1 GB more per player.',
      };
    }
    if (/LogPal.*Save.*complete/i.test(line)) return { level: 'info' };
    if (/Error:|Fatal/i.test(line)) return { level: 'error' };
    if (/Warning:/i.test(line)) return { level: 'warn' };
    return null;
  },

  modDirectory(variantId) {
    return variantId === 'palworld-modded' ? 'Pal/Content/Paks/~mods' : null;
  },
};

/**
 * Lays out the directories UE4SS and pak mods expect, and leaves a README
 * explaining the workflow. We create the structure rather than downloading
 * UE4SS binaries automatically: its releases are not versioned against
 * Palworld builds, and silently shipping a mismatched loader produces a
 * server that crashes on boot with no explanation.
 */
async function setupModLoader(tools: InstallTools): Promise<void> {
  await tools.mkdir('Pal/Content/Paks/~mods');
  await tools.mkdir('Pal/Binaries/Linux/Mods');

  await tools.writeFile(
    'Pal/Content/Paks/~mods/README.txt',
    [
      'Drop .pak mod files in this folder.',
      '',
      'Files here load automatically when the server starts. Remove a file to',
      'disable that mod. The Mods tab in the panel manages this folder for you,',
      'including enabling and disabling without deleting anything.',
      '',
      'Important: Palworld mods are not server-only. Every player usually needs',
      'the same mods installed in their own game, or they will not be able to',
      'join. Check what the mod page says.',
      '',
      'Script mods (UE4SS Lua/C++) go in Pal/Binaries/Linux/Mods instead.',
    ].join('\n'),
  );

  await tools.writeFile(
    'Pal/Binaries/Linux/Mods/README.txt',
    [
      'UE4SS script mods go here, one folder per mod.',
      '',
      'UE4SS itself is not bundled: its releases track Unreal Engine versions,',
      'not Palworld patches, and an incompatible build crashes the server at',
      'boot. Download the release that matches your current Palworld version',
      'from the UE4SS project and upload it into Pal/Binaries/Linux.',
      '',
      'After a Palworld update, check UE4SS still matches before starting.',
    ].join('\n'),
  );
}

export { palworldSettingsSchema };
