import { STEAMCMD_IMAGE } from '../../util/steamcmd.js';
import type { GameManifest } from '../types.js';

/**
 * Valheim, as a manifest.
 *
 * The first game ported from a hand-written adapter, and the proof that the
 * format carries a real one: a SteamCMD install, settings that are command
 * line flags rather than a config file, an optional flag that must be omitted
 * rather than passed empty, a variant with its own install step, and player
 * names read out of the log.
 *
 * Built-in manifests are TypeScript rather than JSON so the compiler checks
 * them. Operator-supplied manifests are JSON with the same shape, checked by
 * `validateManifest` at load instead.
 */
export const valheimManifest: GameManifest = {
  manifestVersion: 1,

  id: 'valheim',
  name: 'Valheim',
  summary: 'Co-op viking survival. Up to 10 players.',
  icon: 'Axe',

  limits: { memoryMib: 4096, cpuCores: 2, diskMib: 10240 },

  variants: [
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
      modDirectory: 'BepInEx/plugins',
    },
  ],

  ports: [
    { purpose: 'game', protocol: 'udp' },
    { purpose: 'query', protocol: 'udp' },
  ],

  // Valheim has no config file worth round-tripping — name, world, password
  // and visibility are launch flags, so every setting is `internal` and the
  // runtime command below reads them.
  settings: [
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
      target: { kind: 'internal' },
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
      target: { kind: 'internal' },
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
      target: { kind: 'internal' },
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
      target: { kind: 'internal' },
    },
  ],

  install: {
    kind: 'steam',
    appId: '896660',
    message: 'Downloading Valheim from Steam — this is a few GB and takes a while…',
  },

  postInstall: [
    {
      variants: ['valheim-bepinex'],
      message: 'Setting up the BepInEx plugins folder…',
      mkdir: 'BepInEx/plugins',
    },
    {
      variants: ['valheim-bepinex'],
      writeFile: {
        path: 'BepInEx/plugins/README.txt',
        // BepInEx itself is not bundled: its releases are versioned against
        // Valheim builds, not against this panel, and shipping a mismatched
        // loader produces a server that crashes at boot with no explanation.
        contents: [
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
      },
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
      './start_server.sh',
      '-name',
      '{{setting.ServerName}}',
      '-port',
      '{{port.game}}',
      '-world',
      '{{setting.WorldName}}',
      '-public',
      '{{setting.Public|number}}',
      // Omitted rather than passed empty: Valheim treats `-password ""` as a
      // password of zero length and refuses to start.
      { when: { ref: 'setting.Password', isSet: true }, args: ['-password', '{{setting.Password}}'] },
    ],
    env: {
      LD_LIBRARY_PATH: '/home/container/linux64:/home/container/steamclient',
      TZ: 'UTC',
    },
    ports: [
      { containerPort: 2456, purpose: 'game', protocol: 'udp' },
      { containerPort: 2457, purpose: 'query', protocol: 'udp' },
    ],
    // No stdin shutdown command. SIGINT triggers a clean save.
    stopTimeoutSeconds: 60,
    readyPattern: 'Game server connected',
  },

  // Order matters: the first match wins, so the specific rules sit above the
  // catch-all "anything saying ERROR" pair at the bottom.
  logRules: [
    {
      pattern: 'Game server connected',
      level: 'success',
      ready: true,
      hint: 'Server is accepting players.',
    },
    {
      pattern: 'Failed to bind|Address already in use|bind\\(\\) failed',
      level: 'error',
      hint: 'Another program is using this port. Change the port under Network and start again.',
    },
    {
      pattern: 'out of memory|Killed process',
      level: 'error',
      hint: 'Valheim ran out of memory. Try raising the memory limit, or ask fewer players to explore different areas at once.',
    },
    {
      // "Got character ZDOID from Erik : 1234567890:1" — ZDOID is a literal
      // token, so the name is the part after "from", up to the id suffix.
      pattern: 'got character\\s+\\S+\\s+from\\s+(.+?)(?:\\s+:\\s|\\s*$)',
      level: 'info',
      playerEvent: { type: 'join', nameGroup: 1 },
    },
    {
      pattern: 'Closing connection to (.+)',
      level: 'info',
      playerEvent: { type: 'leave', nameGroup: 1 },
    },
    { pattern: 'Error:|Fatal|ERROR', level: 'error' },
    { pattern: 'Warning:|WARN', level: 'warn' },
  ],

  console: {
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
  },
};
