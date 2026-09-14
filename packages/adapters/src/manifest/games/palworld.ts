import { STEAMCMD_IMAGE } from '../../util/steamcmd.js';
import type { GameManifest } from '../types.js';

/**
 * Palworld, as a manifest.
 *
 * A harder test of the format than Valheim, and the reason four parts of it
 * exist:
 *
 *   - **Unreal tuples.** Every game setting lives inside one parenthesised
 *     INI value, `OptionSettings=(Difficulty=None,ExpRate=1.000000,…)`, with
 *     per-type formatting Unreal is strict about. That is `target.tuple`.
 *   - **Config values from allocations.** Palworld's own config has to name
 *     the ports the allocator handed out, or the server listens where nothing
 *     is published and looks online while refusing every connection. That is
 *     `configValues`.
 *   - **A seeded config.** Palworld writes PalWorldSettings.ini on first boot
 *     and runs on built-in defaults until then, so wizard choices would apply
 *     to the player's *second* world. That is `postInstall.copyFile`.
 *
 * Linux supports compatible PAK mods. Official Workshop / UE4SS server mods
 * require Windows: https://docs.palworldgame.com/settings-and-operation/mod/
 */

const CONFIG = 'Pal/Saved/Config/LinuxServer/PalWorldSettings.ini';
const SECTION = '/Script/Pal.PalGameWorldSettings';

export const palworldManifest: GameManifest = {
  manifestVersion: 1,

  id: 'palworld',
  name: 'Palworld',
  summary: 'Open-world survival with creature collecting. Up to 32 players.',
  icon: 'PawPrint',

  // Palworld's floor is genuinely high — under 8 GB it crashes under load,
  // and telling someone that after their world corrupts is too late.
  limits: { memoryMib: 16384, cpuCores: 4, diskMib: 30720 },

  variants: [
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
      name: 'Palworld + PAK mods',
      summary: 'Linux server with a managed folder for compatible PAK mods.',
      detail:
        'Upload .pak mods explicitly compatible with the Linux dedicated server. UE4SS scripts, native DLL mods and official Steam Workshop server mods require Windows and are not supported by this Linux edition. Follow each mod’s client and dependency requirements.',
      order: 2,
      tags: ['Mods', 'Advanced'],
      supportsMods: true,
      modLoader: 'none',
      modDirectory: 'Pal/Content/Paks/~mods',
    },
  ],

  ports: [
    { purpose: 'game', protocol: 'udp' },
    { purpose: 'query', protocol: 'udp' },
    { purpose: 'rest', protocol: 'tcp' },
  ],

  settings: [
    {
      key: 'ServerName',
      type: 'string',
      label: 'Server name',
      help: 'Shown in the in-game server browser.',
      tier: 'basic',
      group: 'Server',
      default: 'A ServerForge Palworld server',
      maxLength: 96,
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'ServerName',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'ServerDescription',
      type: 'string',
      label: 'Description',
      help: 'A short line describing your server. Shown when players select it.',
      tier: 'basic',
      group: 'Server',
      default: '',
      maxLength: 256,
      multiline: true,
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'ServerDescription',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'ServerPassword',
      type: 'string',
      label: 'Join password',
      help: 'Leave empty for an open server. Players are asked for this before joining.',
      tier: 'basic',
      group: 'Server',
      default: '',
      secret: true,
      maxLength: 64,
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'ServerPassword',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'ServerPlayerMaxNum',
      type: 'number',
      label: 'Max players',
      help: 'Palworld is memory-hungry: budget about 1 GB per player on top of the base 8 GB.',
      tier: 'basic',
      group: 'Server',
      default: 16,
      min: 1,
      max: 32,
      unit: 'players',
      restartRequired: true,
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'ServerPlayerMaxNum',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'AdminPassword',
      type: 'string',
      label: 'Admin password',
      help: 'Lets you run admin commands from inside the game. Keep it different from the join password.',
      tier: 'basic',
      group: 'Server',
      default: '',
      secret: true,
      maxLength: 64,
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'AdminPassword',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'bIsMultiplay',
      type: 'boolean',
      label: 'Multiplayer',
      help: 'Leave on. Off turns the world into a single-player save.',
      tier: 'expert',
      group: 'Server',
      default: false,
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'bIsMultiplay',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'Difficulty',
      type: 'enum',
      label: 'Difficulty preset',
      help: 'Palworld applies its own curve on top of your individual rate settings. "None" means your rates are used exactly as set.',
      tier: 'basic',
      group: 'Difficulty',
      default: 'None',
      options: [
        {
          value: 'None',
          label: 'Custom (use my rates)',
        },
        {
          value: 'Casual',
          label: 'Casual',
        },
        {
          value: 'Normal',
          label: 'Normal',
        },
        {
          value: 'Hard',
          label: 'Hard',
        },
      ],
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'Difficulty',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'DeathPenalty',
      type: 'enum',
      label: 'What players drop on death',
      help: 'The single most argued-about setting on any Palworld server.',
      tier: 'basic',
      group: 'Difficulty',
      default: 'All',
      options: [
        {
          value: 'None',
          label: 'Nothing',
        },
        {
          value: 'Item',
          label: 'Items only',
        },
        {
          value: 'ItemAndEquipment',
          label: 'Items and equipment',
        },
        {
          value: 'All',
          label: 'Everything, including Pals',
        },
      ],
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'DeathPenalty',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'ExpRate',
      type: 'number',
      label: 'Experience rate',
      help: '1 is the normal game. 2 means players level twice as fast.',
      tier: 'basic',
      group: 'Difficulty',
      default: 1,
      min: 0.1,
      max: 20,
      step: 0.1,
      unit: '×',
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'ExpRate',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'PalCaptureRate',
      type: 'number',
      label: 'Pal capture rate',
      help: 'Higher values make Pals easier to catch.',
      tier: 'advanced',
      group: 'Difficulty',
      default: 1,
      min: 0.5,
      max: 20,
      step: 0.1,
      unit: '×',
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'PalCaptureRate',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'CollectionDropRate',
      type: 'number',
      label: 'Gathering rate',
      help: 'How much ore, wood and stone each hit yields.',
      tier: 'advanced',
      group: 'Difficulty',
      default: 1,
      min: 0.1,
      max: 20,
      step: 0.1,
      unit: '×',
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'CollectionDropRate',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'EnemyDropItemRate',
      type: 'number',
      label: 'Enemy drop rate',
      help: 'How much loot defeated enemies leave behind.',
      tier: 'advanced',
      group: 'Difficulty',
      default: 1,
      min: 0.1,
      max: 20,
      step: 0.1,
      unit: '×',
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'EnemyDropItemRate',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'DayTimeSpeedRate',
      type: 'number',
      label: 'Daytime speed',
      help: 'Higher values make days pass faster.',
      tier: 'advanced',
      group: 'Difficulty',
      default: 1,
      min: 0.1,
      max: 5,
      step: 0.1,
      unit: '×',
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'DayTimeSpeedRate',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'NightTimeSpeedRate',
      type: 'number',
      label: 'Nighttime speed',
      help: 'Raise this to shorten nights, which players generally prefer.',
      tier: 'advanced',
      group: 'Difficulty',
      default: 1,
      min: 0.1,
      max: 5,
      step: 0.1,
      unit: '×',
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'NightTimeSpeedRate',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'bEnablePlayerToPlayerDamage',
      type: 'boolean',
      label: 'Players can damage each other',
      help: 'Off makes the server fully cooperative.',
      tier: 'basic',
      group: 'Rules',
      default: false,
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'bEnablePlayerToPlayerDamage',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'bEnableFriendlyFire',
      type: 'boolean',
      label: 'Friendly fire',
      help: 'Whether guild members can hurt each other.',
      tier: 'advanced',
      group: 'Rules',
      default: false,
      showWhen: {
        key: 'bEnablePlayerToPlayerDamage',
        equals: [true],
      },
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'bEnableFriendlyFire',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'bEnableInvaderEnemy',
      type: 'boolean',
      label: 'Raids on player bases',
      help: 'Periodic attacks on bases. Turning this off is the usual fix for base-destruction complaints.',
      tier: 'advanced',
      group: 'Rules',
      default: true,
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'bEnableInvaderEnemy',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'BuildObjectDamageRate',
      type: 'number',
      label: 'Structure damage rate',
      help: 'How much damage buildings take. 0 makes bases indestructible.',
      tier: 'advanced',
      group: 'Rules',
      default: 1,
      min: 0,
      max: 10,
      step: 0.1,
      unit: '×',
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'BuildObjectDamageRate',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'GuildPlayerMaxNum',
      type: 'number',
      label: 'Max guild size',
      help: 'How many players can be in one guild.',
      tier: 'advanced',
      group: 'Rules',
      default: 20,
      min: 1,
      max: 100,
      unit: 'players',
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'GuildPlayerMaxNum',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'BaseCampMaxNumInGuild',
      type: 'number',
      label: 'Bases per guild',
      help: 'Each active base costs server memory and CPU. Lower this if the server struggles.',
      tier: 'advanced',
      group: 'Rules',
      default: 4,
      min: 1,
      max: 10,
      unit: 'bases',
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'BaseCampMaxNumInGuild',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'bIsUseBackupSaveData',
      type: 'boolean',
      label: "Keep Palworld's own save backups",
      help: 'Independent of ServerForge backups. Costs disk but has saved many worlds.',
      tier: 'advanced',
      group: 'Performance',
      default: true,
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'bIsUseBackupSaveData',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'AutoSaveSpan',
      type: 'number',
      label: 'Autosave interval',
      help: 'Seconds between world saves. Long intervals cause a visible stutter when the save finally happens.',
      tier: 'advanced',
      group: 'Performance',
      default: 180,
      min: 30,
      max: 3600,
      unit: 'seconds',
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'AutoSaveSpan',
        tuple: 'OptionSettings',
      },
    },
    {
      key: 'sf_use_perf_threads',
      type: 'boolean',
      label: 'Performance threading flags',
      help: 'Adds the community-standard multithreading flags to the launch command. Recommended on any machine with 4 or more cores.',
      tier: 'advanced',
      group: 'Performance',
      default: true,
      restartRequired: true,
      target: {
        kind: 'internal',
      },
    },
    {
      key: 'RESTAPIEnabled',
      type: 'boolean',
      label: 'Enable the REST API',
      help: 'Lets tools query players and run admin commands over HTTP. The panel uses it for the live player list when it is on.',
      tier: 'advanced',
      group: 'Performance',
      default: true,
      restartRequired: true,
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'RESTAPIEnabled',
        tuple: 'OptionSettings',
      },
    },
  ],

  // The allocator picks the ports; Palworld's own config has to agree with it.
  configValues: [
    {
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'PublicPort',
        tuple: 'OptionSettings',
      },
      value: '{{port.game}}',
    },
    {
      target: {
        kind: 'ini',
        file: CONFIG,
        section: SECTION,
        key: 'RESTAPIPort',
        tuple: 'OptionSettings',
      },
      value: '{{port.rest}}',
    },
  ],

  install: {
    kind: 'steam',
    appId: '2394010',
    message: 'Downloading Palworld from Steam — this is around 8 GB and takes a while…',
  },

  postInstall: [
    {
      message: 'Preparing the configuration…',
      mkdir: 'Pal/Saved/Config/LinuxServer',
    },
    {
      // Palworld only writes this on first boot and runs on built-in defaults
      // until then, so without seeding it the wizard's choices would apply to
      // the second world rather than the first.
      copyFile: {
        from: 'DefaultPalWorldSettings.ini',
        to: CONFIG,
        ifMissing: true,
      },
    },

    {
      variants: ['palworld-modded'],
      message: 'Preparing the PAK mods folder…',
      mkdir: 'Pal/Content/Paks/~mods',
    },
  ],

  runtime: {
    image: STEAMCMD_IMAGE,
    workingDir: '/home/container',
    // The SteamCMD image is used for its runtime libraries, but its own
    // entrypoint is steamcmd — without clearing it the command below
    // arrives as arguments to steamcmd and the game never starts.
    entrypoint: [],
    command: [
      './PalServer.sh',
      '-port={{port.game}}',
      '-queryport={{port.query}}',
      '-players={{setting.ServerPlayerMaxNum}}',
      '-publiclobby=false',
      '-NoAsyncLoadingThread',
      {
        when: { ref: 'setting.sf_use_perf_threads', isSet: true },
        args: ['-useperfthreads', '-UseMultithreadForDS'],
      },
    ],
    env: {
      // The shipped launcher resolves Steam libraries relative to itself.
      LD_LIBRARY_PATH: '/home/container/linux64:/home/container/steamclient',
      TZ: 'UTC',
      HOME: '/home/container',
    },
    ports: [
      { containerPort: 8211, purpose: 'game', protocol: 'udp' },
      { containerPort: 27015, purpose: 'query', protocol: 'udp' },
      { containerPort: 8212, purpose: 'rest', protocol: 'tcp' },
    ],
    // No console command interface on stdin. SIGINT triggers Palworld's clean
    // shutdown path, which flushes the world save.
    stopTimeoutSeconds: 60,
    readyPattern: 'Setting breakpad minidump AppID|Running Palworld dedicated server',
  },

  logRules: [
    {
      pattern: 'Running Palworld dedicated server',
      level: 'success',
      ready: true,
      hint: 'Server is accepting players.',
    },
    {
      pattern: 'Setting breakpad minidump AppID = 2394010',
      level: 'info',
      ready: true,
    },
    {
      pattern: 'Failed to bind|Address already in use',
      level: 'error',
      hint: 'Another program is using this port. Change the port under Network and start again.',
    },
    {
      pattern: 'out of memory|Killed process',
      level: 'error',
      hint: 'Palworld ran out of memory. It needs at least 8 GB, and about 1 GB more per player.',
    },
    { pattern: 'LogPal.*Save.*complete', level: 'info' },
    { pattern: 'Error:|Fatal', level: 'error' },
    { pattern: 'Warning:', level: 'warn' },
  ],

  console: {
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
  },
};
