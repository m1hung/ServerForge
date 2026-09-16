import type { GameAdapter } from '../types.js';
import { mergeProperties } from '../util/properties.js';
import { STEAMCMD_IMAGE } from '../util/steamcmd.js';
import { bedrockSettings } from './settings.js';
import { bedrockDownloadUrl, latestBedrock, resolveBedrockVersion } from './versions.js';

export const bedrockAdapter: GameAdapter = {
  id: 'minecraft-bedrock',
  name: 'Minecraft: Bedrock Edition',
  summary: 'Official Bedrock server for compatible Bedrock clients. Separate from Java Edition.',
  icon: 'Box',
  variants: [
    {
      id: 'bedrock-vanilla',
      name: 'Bedrock Dedicated Server',
      order: 1,
      recommended: true,
      summary: 'The official Minecraft Bedrock server, with worlds and native add-ons.',
      detail:
        'Use Files to manage Bedrock worlds, behavior packs and resource packs. Java mods, plugins and CurseForge Java server packs cannot run here. Join using the address and UDP port in Connections; some console editions restrict adding custom servers.',
      supportsMods: false,
    },
  ],
  defaultLimits: () => ({ memoryMib: 4096, cpuCores: 2, diskMib: 10240 }),
  requiredPorts: () => [{ purpose: 'game', protocol: 'udp' }],
  settingsSchema: () => bedrockSettings,
  eula: () => ({
    key: 'minecraft-eula',
    label: 'I accept the Minecraft End User Licence Agreement',
    url: 'https://aka.ms/MinecraftEULA',
    file: 'eula.txt',
    contents: '# Accepted through ServerForge\neula=true\n',
  }),
  listVersions: async () => [await latestBedrock()],
  resolveVersion: async (_variant, version) => resolveBedrockVersion(version),
  async install(ctx, tools, report) {
    await report.phase('resolving_version', 'Looking up the official Bedrock server…', 10);
    const version = await resolveBedrockVersion(ctx.version);
    await report.runtime?.({ version: version.id });
    await report.phase('downloading', `Downloading Bedrock ${version.id}…`, 25);
    // Mojang does not publish a checksum here. Use only its fixed HTTPS origin;
    // the shared downloader still validates redirects, addresses and size.
    await tools.download(bedrockDownloadUrl(version.id), 'bedrock-server.zip', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    await report.phase('extracting', 'Extracting the Bedrock server…', 60);
    await tools.unzip('bedrock-server.zip', '.');
    if (!(await tools.exists('bedrock_server')))
      throw new Error('The downloaded ZIP does not contain the Linux Bedrock server.');
    const bundledPacks = [];
    for (const directory of ['behavior_packs', 'resource_packs'])
      for (const name of await tools.listDir(directory)) bundledPacks.push(`${directory}/${name}`);
    await tools.writeFile('.serverforge/bedrock-distribution.json', JSON.stringify(bundledPacks));
    await tools.remove('bedrock-server.zip');
    await report.phase('configuring', 'Writing your Bedrock settings…', 85);
    await this.applySettings(ctx, tools);
    await tools.writeFile('eula.txt', this.eula!(ctx.variantId)!.contents);
    await report.phase('finalizing', 'Ready to start.', 100);
  },
  async applySettings(ctx, tools) {
    const port = ctx.allocations.find((allocation) => allocation.purpose === 'game');
    if (!port) throw new Error('Bedrock requires an allocated UDP game port.');
    const properties = Object.fromEntries(
      bedrockSettings.map((setting) => [
        setting.key,
        String(ctx.settings[setting.key] ?? setting.default),
      ]),
    );
    properties['server-port'] = String(port.port);
    // IPv4 is the published game endpoint. Keep IPv6 inside the container.
    properties['server-portv6'] = '19133';
    // BDS 1.26.45 returns an empty discovery pong when this is false, even
    // on the assigned gameplay port. Extra default-port listeners stay inside
    // the bridge container: Docker publishes only our allocated game port.
    properties['enable-lan-visibility'] = 'true';
    properties.transport = 'raknet';
    await tools.writeFile(
      'server.properties',
      mergeProperties((await tools.readFile('server.properties')) ?? '', properties),
    );
  },
  startup: () => ({
    // Reuse the Ubuntu 24 runtime and its native libraries already used by our
    // Steam games. Clear SteamCMD's entrypoint; Bedrock does not use Steam.
    image: STEAMCMD_IMAGE,
    entrypoint: [],
    command: ['./bedrock_server'],
    workingDir: '/home/container',
    env: { LD_LIBRARY_PATH: '.', HOME: '/home/container' },
    ports: [{ containerPort: 19132, purpose: 'game', protocol: 'udp' }],
    stopCommand: 'stop\n',
    stopTimeoutSeconds: 120,
    readyPattern: 'Server started\\.',
  }),
  reportsPlayers: true,
  inspectLog(line) {
    if (/\bServer started\./.test(line)) return { level: 'success', ready: true };
    const player = line.match(/\bPlayer (connected|disconnected): (.+?), xuid:/);
    if (player)
      return {
        level: 'info',
        playerEvent: { type: player[1] === 'connected' ? 'join' : 'leave', name: player[2]! },
      };
    if (/\b(ERROR|Error):|\bERROR\]/.test(line)) return { level: 'error' };
    if (/\bWARN(?:ING)?\]/.test(line)) return { level: 'warn' };
    return null;
  },
  consoleGlossary: () => ({
    acceptsCommands: true,
    note: 'Bedrock commands differ from Java. Omit the leading slash and put gamertags containing spaces in double quotes. Gameplay commands may require Allow cheats. Use Backups for a consistent world backup.',
    commands: [
      {
        category: 'Server',
        command: 'help',
        summary: 'List commands available in this Bedrock version.',
      },
      {
        category: 'Server',
        command: 'list',
        summary: 'Show players currently connected to the server.',
      },
      {
        category: 'Server',
        command: 'say <message>',
        summary: 'Send a message to everyone playing.',
      },
      {
        category: 'Server',
        command: 'stop',
        summary: 'Save the world and shut down the server gracefully.',
      },
      {
        category: 'Players',
        command: 'allowlist add "<gamertag>"',
        summary: 'Allow a player to join an invite-only game.',
      },
      {
        category: 'Players',
        command: 'allowlist remove "<gamertag>"',
        summary: 'Remove a player from the game allowlist.',
      },
      {
        category: 'Players',
        command: 'allowlist list',
        summary: 'Show the players allowed to join.',
      },
      {
        category: 'Players',
        command: 'allowlist reload',
        summary: 'Reload allowlist.json after editing it in Files.',
      },
      {
        category: 'Players',
        command: 'op "<gamertag>"',
        summary: 'Give a player permission to administer the game.',
      },
      {
        category: 'Players',
        command: 'deop "<gamertag>"',
        summary: 'Remove a player’s operator permission.',
      },
      {
        category: 'Players',
        command: 'kick "<gamertag>" [reason]',
        summary: 'Disconnect a player from the game.',
      },
      {
        category: 'Players',
        command: 'permission reload',
        summary: 'Reload permissions.json after editing it in Files.',
      },
      {
        category: 'World',
        command: 'time set day',
        summary: 'Change the world time to daytime; requires cheats.',
      },
      {
        category: 'World',
        command: 'weather clear',
        summary: 'Clear rain and thunder; requires cheats.',
      },
      {
        category: 'World',
        command: 'difficulty <peaceful|easy|normal|hard>',
        summary: 'Change the world’s difficulty.',
      },
    ],
  }),
};
