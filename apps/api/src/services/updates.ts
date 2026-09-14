import fs from 'node:fs/promises';
import path from 'node:path';
import type { MultipartFile } from '@fastify/multipart';
import { getAdapter } from '@serverforge/adapters';
import { prisma, type Server } from '@serverforge/db';
import { badRequest, conflict } from '@serverforge/core';
import { contextOf, loadServer, startServer } from '../routes/servers.js';
import { localDataPath, hostDataPath } from '../lib/storage-paths.js';
import { installToolsFor } from './install-tools.js';
import { saveServerPack } from './server-pack-upload.js';
import { serverFile } from '../lib/server-files.js';
import {
  createBackup,
  operationRoot,
  replaceServerFiles,
  savedConfigurationSchema,
  savedConfiguration,
} from './backups.js';
import { fileChecksum } from './file-manager.js';
import { activity } from './server-events.js';

type UpdatePlan = {
  state: 'preparing' | 'ready' | 'applying' | 'completed' | 'failed';
  version: string;
  error?: string;
  changes?: { added: string[]; changed: string[]; removed: string[]; total: number };
  preserve: string[];
  configuration?: ReturnType<typeof savedConfiguration>;
  preparedAt?: string;
};
const planPath = (serverUid: string) => path.join(operationRoot(serverUid), 'update.json');
export async function readUpdate(serverUid: string): Promise<UpdatePlan | null> {
  return fs
    .readFile(planPath(serverUid), 'utf8')
    .then((s) => JSON.parse(s) as UpdatePlan)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
}
async function writePlan(serverUid: string, plan: UpdatePlan) {
  await fs.mkdir(operationRoot(serverUid), { recursive: true });
  await fs.writeFile(`${planPath(serverUid)}.tmp`, JSON.stringify(plan), { mode: 0o600 });
  await fs.rename(`${planPath(serverUid)}.tmp`, planPath(serverUid));
}
export async function copyDirectory(source: string, destination: string) {
  await fs.cp(source, destination, {
    recursive: true,
    force: true,
    filter: async (file) => {
      const stat = await fs.lstat(file);
      if (!stat.isFile() && !stat.isDirectory())
        throw badRequest('Updates cannot copy links or special files.');
      return true;
    },
  });
}
export async function preservedPaths(server: Server) {
  if (server.gameId === 'palworld') return ['Pal/Saved'];
  if (server.gameId === 'valheim')
    return [
      'worlds',
      'worlds_local',
      'BepInEx/config',
      'adminlist.txt',
      'bannedlist.txt',
      'permittedlist.txt',
    ];
  if (server.gameId !== 'minecraft-java') return [];
  const root = localDataPath(server.dataPath);
  const world = String((server.settings as Record<string, unknown>)['level-name'] || 'world');
  await serverFile(root, world);
  const names = [
    world,
    `${world}_nether`,
    `${world}_the_end`,
    'config',
    'defaultconfigs',
    'server.properties',
    'ops.json',
    'whitelist.json',
    'banned-players.json',
    'banned-ips.json',
    'usercache.json',
  ];
  for (const name of await fs.readdir(root)) {
    const target = await serverFile(root, name);
    if (
      (await fs.lstat(target)).isDirectory() &&
      (await fs.lstat(path.join(target, 'level.dat')).catch(() => null))
    )
      names.push(name);
  }
  const plugins = await serverFile(root, 'plugins');
  for (const entry of await fs.readdir(plugins, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) names.push(`plugins/${entry.name}`);
  }
  return [...new Set(names)];
}
export async function directoryInventory(root: string, omit: string[] = []) {
  const files = new Map<string, string>();
  async function visit(relative: string) {
    if (omit.some((p) => relative === p || relative.startsWith(`${p}/`))) return;
    const target = await serverFile(root, relative);
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(target))
        await visit(relative ? `${relative}/${entry}` : entry);
    } else if (stat.isFile()) {
      if (files.size >= 50000) throw badRequest('Too many installation files to compare.');
      files.set(relative, await fileChecksum(target));
    } else throw badRequest('Updates cannot include special files.');
  }
  await visit('');
  return files;
}
export function compareInventory(before: Map<string, string>, after: Map<string, string>) {
  const added = [...after.keys()].filter((p) => !before.has(p));
  const changed = [...after.keys()].filter((p) => before.has(p) && before.get(p) !== after.get(p));
  const removed = [...before.keys()].filter((p) => !after.has(p));
  return {
    added: added.slice(0, 200),
    changed: changed.slice(0, 200),
    removed: removed.slice(0, 200),
    total: added.length + changed.length + removed.length,
  };
}
export async function prepareUpdate(
  server: Awaited<ReturnType<typeof loadServer>>,
  version: string,
  upload?: MultipartFile,
  packVersion?: string,
) {
  if (!['running', 'offline', 'crashed'].includes(server.state))
    throw conflict('Wait for the current server operation.');
  if (upload && (server.gameId !== 'minecraft-java' || server.variantId !== 'custom-modpack'))
    throw badRequest('Server pack uploads require the custom modpack edition.');
  if (server.variantId === 'custom-modpack' && !upload)
    throw badRequest('Upload the new server pack ZIP.');
  const staged = path.join(operationRoot(server.uid), 'candidate');
  const plan: UpdatePlan = { state: 'preparing', version, preserve: await preservedPaths(server) };
  await writePlan(server.uid, plan);
  try {
    await fs.rm(staged, { recursive: true, force: true });
    await fs.mkdir(staged, { recursive: true });
    // Unknown adapters may keep saves anywhere: install over an isolated full copy.
    if (!['minecraft-java', 'palworld', 'valheim'].includes(server.gameId))
      await copyDirectory(localDataPath(server.dataPath), staged);
    if (upload) await saveServerPack(staged, upload);
    const adapter = getAdapter(server.gameId),
      resolved = await adapter.resolveVersion(server.variantId, version);
    const configuration = savedConfiguration(server);
    configuration.version = resolved.id;
    configuration.build = resolved.build ?? null;
    configuration.javaMajor =
      (await adapter.detectRuntime?.(server.variantId, resolved.id)) ?? server.javaMajor;
    if (packVersion !== undefined && server.variantId === 'modrinth-modpack')
      configuration.settings.modpack_version = packVersion;
    if (upload) configuration.settings.modpack_zip_url = '';
    const ctx = contextOf({ ...server, ...configuration, dataPath: hostDataPath(staged) });
    await adapter.install(ctx, installToolsFor(hostDataPath(staged)), {
      phase: async (phase, message) => {
        await prisma.installLog.create({ data: { serverId: server.id, phase, message } });
      },
      log: async (message) => {
        await prisma.installLog.create({ data: { serverId: server.id, phase: 'update', message } });
      },
      runtime: async (detected) => {
        if (detected.javaMajor) configuration.javaMajor = detected.javaMajor;
        if (detected.version) configuration.version = detected.version;
      },
    });
    const ignored = [...plan.preserve, '.serverforge', 'logs', 'crash-reports'];
    plan.changes = compareInventory(
      await directoryInventory(localDataPath(server.dataPath), ignored),
      await directoryInventory(staged, ignored),
    );
    plan.configuration = configuration;
    plan.version = configuration.version;
    plan.state = 'ready';
    plan.preparedAt = new Date().toISOString();
    await writePlan(server.uid, plan);
  } catch (error) {
    await writePlan(server.uid, {
      ...plan,
      state: 'failed',
      error: error instanceof Error ? error.message : 'Preparation failed',
    });
    throw error;
  }
}
export async function applyUpdate(server: Server, startAfter: boolean) {
  const plan = await readUpdate(server.uid);
  if (!plan || plan.state !== 'ready' || !plan.configuration)
    throw conflict('Prepare and review an update first.');
  const configuration = savedConfigurationSchema.parse(plan.configuration);
  if (configuration.gameId !== server.gameId || configuration.variantId !== server.variantId)
    throw conflict('The server edition changed. Prepare the update again.');
  const staged = path.join(operationRoot(server.uid), 'candidate');
  await writePlan(server.uid, { ...plan, state: 'applying' });
  try {
    const backup = await createBackup(server, `Before update to ${plan.version}`, undefined, false);
    const root = localDataPath(server.dataPath);
    // Copy current saves only after shutdown; never roll a world back to preparation time.
    for (const relative of await preservedPaths(server)) {
      const source = await serverFile(root, relative);
      if (!(await fs.lstat(source).catch(() => null))) continue;
      const destination = await serverFile(staged, relative);
      await fs.rm(destination, { force: true, recursive: true });
      await copyDirectory(source, destination);
    }
    configuration.settings = {
      ...(server.settings as Record<string, string | number | boolean>),
      ...(configuration.settings.modpack_version !== undefined
        ? { modpack_version: configuration.settings.modpack_version }
        : {}),
      ...(server.variantId === 'custom-modpack' ? { modpack_zip_url: '' } : {}),
    };
    Object.assign(configuration, {
      environment: server.environment,
      startupOverride: server.startupOverride,
      javaFlagsPreset: server.javaFlagsPreset,
      customJavaFlags: server.customJavaFlags,
      memoryMib: server.memoryMib,
      cpuCores: server.cpuCores,
      diskMib: server.diskMib,
      swapMib: server.swapMib,
      ioWeight: server.ioWeight,
    });
    await replaceServerFiles(server, staged, configuration, 'updating');
    await writePlan(server.uid, { ...plan, state: 'completed' });
    await activity(
      server.id,
      'update.completed',
      `Updated to ${plan.version}. Rollback backup: ${backup.name}`,
    );
    if (startAfter) await startServer(server.id);
  } catch (error) {
    await writePlan(server.uid, {
      ...plan,
      state: 'failed',
      error: error instanceof Error ? error.message : 'Update failed',
    });
    throw error;
  }
}
