import fs from 'node:fs/promises';
import path from 'node:path';
import {
  brand,
  conflict,
  defaultsFor,
  INERT_STATES,
  unprocessable,
  validateSettings,
  type CreateServerInput,
  type ResourceLimits,
  type ServerState,
} from '@serverforge/core';
import { getAdapter, getVariant, type ServerContext } from '@serverforge/adapters';
import { prisma, uid as makeUid, type Server, type ServerWithRelations } from '@serverforge/db';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { recordActivity, setServerState } from '../lib/events.js';
import { hostDataPath, localDataPath } from '../lib/storage-paths.js';
import { claimAllocations, releaseAllocations } from './allocations.js';
import { getRuntime } from '../runtime/index.js';
import { forwardablePorts, mapPorts } from './ports.js';
import { closeGamePorts, openGamePorts } from './upnp.js';

/**
 * Server lifecycle.
 *
 * Creation is transactional up to the point of scheduling the install: the
 * DB row, its allocations and its directory either all exist, or none do.
 * The long-running install itself happens in a worker.
 */

export async function loadServer(serverUid: string): Promise<ServerWithRelations> {
  return prisma.server.findUniqueOrThrow({
    where: { uid: serverUid },
    include: { allocations: true, node: true, owner: true },
  });
}

/** Builds the adapter-facing context from a DB row. */
export function buildContext(server: {
  uid: string;
  name: string;
  dataPath: string;
  version: string;
  build: string | null;
  javaMajor?: number | null;
  variantId: string;
  settings: unknown;
  environment: unknown;
  memoryMib: number;
  cpuCores: number;
  javaFlagsPreset: string;
  customJavaFlags: string | null;
  allocations: { ip: string; port: number; purpose: string; primary: boolean }[];
}): ServerContext {
  return {
    serverUid: server.uid,
    name: server.name,
    // Adapters and install tools read/write through the API process.
    dataPath: localDataPath(server.dataPath),
    version: server.version,
    build: server.build,
    runtimeMajor: server.javaMajor ?? null,
    variantId: server.variantId,
    settings: (server.settings ?? {}) as ServerContext['settings'],
    memoryMib: server.memoryMib,
    cpuCores: server.cpuCores,
    allocations: server.allocations.map((a) => ({
      ip: a.ip,
      port: a.port,
      purpose: a.purpose,
      primary: a.primary,
    })),
    environment: (server.environment ?? {}) as Record<string, string>,
    javaFlagsPreset: server.javaFlagsPreset,
    customJavaFlags: server.customJavaFlags,
  };
}

export async function createServer(
  input: CreateServerInput,
  actor: { id: string; displayName: string },
): Promise<Server> {
  const adapter = getAdapter(input.gameId);
  getVariant(input.gameId, input.variantId); // throws 404 on a bad variant

  // Validate settings against the adapter's schema before touching the DB —
  // a rejected deploy should cost nothing.
  const schema = adapter.settingsSchema(input.variantId);
  const validated = validateSettings(schema, { ...defaultsFor(schema), ...input.settings });
  if (!validated.ok) {
    throw unprocessable('Some settings need fixing before we can deploy.', validated.issues);
  }

  if (input.variantId === 'custom-modpack') {
    const zipUrl = String(validated.values.modpack_zip_url ?? '').trim();
    const stagingId = String(validated.values.modpack_staging_id ?? '').trim();
    if (!zipUrl && !stagingId) {
      throw unprocessable('Choose a modpack before creating the server.', [
        {
          key: 'modpack_zip_url',
          message: 'Upload a server pack .zip or paste a download link.',
        },
      ]);
    }
  }

  const node = input.nodeId
    ? await prisma.node.findUniqueOrThrow({ where: { uid: input.nodeId } })
    : await prisma.node.findFirstOrThrow({ where: { online: true, maintenance: false } });

  await assertCapacity(node.id, input.limits);

  const serverUid = makeUid();
  const dataPath = path.join(node.dataRoot, serverUid);

  const server = await prisma.$transaction(async (tx) => {
    const created = await tx.server.create({
      data: {
        uid: serverUid,
        name: input.name,
        description: input.description ?? null,
        state: 'creating',
        ownerId: actor.id,
        nodeId: node.id,
        gameId: input.gameId,
        variantId: input.variantId,
        version: input.version,
        settings: validated.values as never,
        memoryMib: input.limits.memoryMib,
        cpuCores: input.limits.cpuCores,
        diskMib: input.limits.diskMib,
        swapMib: input.limits.swapMib ?? null,
        ioWeight: input.limits.ioWeight ?? 500,
        dataPath,
      },
    });

    await claimAllocations(tx, {
      nodeId: node.id,
      serverId: created.id,
      requests: adapter.requiredPorts(input.variantId),
      ...(input.port !== undefined ? { preferredPort: input.port } : {}),
    });

    return created;
  });

  // Directory creation is outside the transaction because it cannot be rolled
  // back — so it happens last, and a failure here leaves a clean-up path.
  try {
    const localPath = localDataPath(dataPath);
    await fs.mkdir(localPath, { recursive: true });
    // The container runs as uid 1000; without this the server cannot write
    // its own world, which surfaces as a baffling permissions crash.
    const { chownForGame } = await import('../lib/ownership.js');
    await chownForGame(localPath);
  } catch (error) {
    await prisma.server.delete({ where: { id: server.id } }).catch(() => undefined);
    throw conflict(
      'Could not create the server folder on disk.',
      'Check that the data directory exists and is writable by the panel.',
    );
  }

  await recordActivity({
    serverId: server.id,
    actorId: actor.id,
    actorName: actor.displayName,
    action: 'server.create',
    message: `${actor.displayName} created this server.`,
    metadata: { gameId: input.gameId, variantId: input.variantId, version: input.version },
  });

  return server;
}

/**
 * Refuses a deploy that would oversubscribe the node beyond its headroom.
 * Better to say "not enough memory" now than to let two servers fight over
 * RAM and have the kernel pick a loser at 3am.
 */
async function assertCapacity(nodeId: string, limits: ResourceLimits): Promise<void> {
  const node = await prisma.node.findUniqueOrThrow({ where: { id: nodeId } });
  if (node.memoryMib <= 0) return; // capacity tracking disabled for this node

  const allocated = await prisma.server.aggregate({
    where: { nodeId, state: { not: 'deleting' } },
    _sum: { memoryMib: true, diskMib: true },
  });

  const usable = Math.floor(node.memoryMib * (1 - node.overheadPct / 100));
  const wouldUse = (allocated._sum.memoryMib ?? 0) + limits.memoryMib;

  if (wouldUse > usable) {
    const free = Math.max(0, usable - (allocated._sum.memoryMib ?? 0));
    throw conflict(
      `Not enough memory on this machine — ${free} MB free, ${limits.memoryMib} MB requested.`,
      'Lower the memory for this server, or free some up by deleting an unused one.',
    );
  }
}

// ────────────────────────────────────────────────────────────────── power ──

const STARTABLE: ServerState[] = ['offline', 'crashed', 'install_failed'];

export async function startServer(serverUid: string, actor?: { id: string; displayName: string }) {
  const server = await loadServer(serverUid);

  if (server.state === 'running' || server.state === 'starting') {
    throw conflict('That server is already running.');
  }
  if (server.state === 'suspended') {
    throw conflict('This server is suspended.', 'An administrator needs to unsuspend it first.');
  }
  if (!STARTABLE.includes(server.state)) {
    throw conflict(
      `The server is busy (${server.state.replace('_', ' ')}). Wait for that to finish.`,
    );
  }
  if (!server.installedAt) {
    throw conflict(
      'This server has not finished installing yet.',
      'Watch the install progress on the server page — it will start on its own if you asked it to.',
    );
  }

  await setServerState(serverUid, 'starting');

  const adapter = getAdapter(server.gameId);
  const ctx = buildContext(server);
  const plan = adapter.startup(ctx);
  const runtime = getRuntime(server.node);

  try {
    // Settings are re-materialised on every start: this is what makes the
    // settings page feel instant — save, restart, done, with no "apply" step.
    const { createInstallTools } = await import('./install-tools.js');
    await adapter.applySettings(ctx, createInstallTools({ dataPath: localDataPath(server.dataPath), runtime }));

    await runtime.ensureImage(plan.image);

    // A container may survive from the previous run; recreating keeps the
    // spec authoritative after a settings or limits change.
    if (server.containerId) {
      await runtime.remove(server.containerId, { force: true }).catch(() => undefined);
    }

    const ports = mapPorts(plan.ports, server.allocations);

    const containerId = await runtime.create({
      name: `${brand.resourcePrefix}-${server.uid}`,
      image: plan.image,
      command: plan.command,
      workingDir: plan.workingDir,
      env: plan.env,
      // Docker binds are resolved on the host, not inside the API container.
      dataPath: hostDataPath(server.dataPath),
      limits: {
        memoryMib: server.memoryMib,
        cpuCores: server.cpuCores,
        diskMib: server.diskMib,
        ...(server.swapMib !== null ? { swapMib: server.swapMib } : {}),
        ioWeight: server.ioWeight,
      },
      ports,
      network: config.DOCKER_NETWORK,
      labels: {
        [`${brand.labelNamespace}/managed`]: 'true',
        [`${brand.labelNamespace}/server`]: server.uid,
        [`${brand.labelNamespace}/game`]: server.gameId,
      },
    });

    await prisma.server.update({ where: { id: server.id }, data: { containerId } });
    await runtime.start(containerId);
    await setServerState(serverUid, 'starting', { containerId });

    // Ask the router to forward the player-facing port. Deliberately after the
    // server is up and outside the failure path: a router that will not
    // cooperate is not a reason to fail a start that otherwise worked.
    void openGamePorts(serverUid, forwardablePorts(plan.ports, server.allocations)).catch((error) =>
      logger.warn({ error, serverUid }, 'port forwarding failed'),
    );

    if (actor) {
      await recordActivity({
        serverId: server.id,
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'server.start',
        message: `${actor.displayName} started the server.`,
      });
    }
  } catch (error) {
    logger.error({ error, serverUid }, 'failed to start server');
    await setServerState(serverUid, 'crashed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

export async function stopServer(
  serverUid: string,
  options: { force?: boolean } = {},
  actor?: { id: string; displayName: string },
) {
  const server = await loadServer(serverUid);

  if (INERT_STATES.includes(server.state)) {
    throw conflict('That server is not running.');
  }
  if (!server.containerId) {
    await setServerState(serverUid, 'offline');
    return;
  }

  const runtime = getRuntime(server.node);
  await setServerState(serverUid, 'stopping');

  const adapter = getAdapter(server.gameId);
  const plan = adapter.startup(buildContext(server));

  if (options.force) {
    await runtime.kill(server.containerId);
  } else {
    await runtime.stop(server.containerId, {
      ...(plan.stopCommand ? { stopCommand: plan.stopCommand } : {}),
      timeoutSeconds: plan.stopTimeoutSeconds,
    });
  }

  await setServerState(serverUid, 'offline');

  // Close the router again. A forward left open to a port nothing listens on
  // is a small hole with no purpose, and it would collide with the next
  // server that gets handed this allocation.
  void closeGamePorts(serverUid).catch((error) =>
    logger.warn({ error, serverUid }, 'could not close forwarded ports'),
  );

  if (actor) {
    await recordActivity({
      serverId: server.id,
      actorId: actor.id,
      actorName: actor.displayName,
      action: options.force ? 'server.kill' : 'server.stop',
      message: `${actor.displayName} ${options.force ? 'force-stopped' : 'stopped'} the server.`,
    });
  }
}

export async function restartServer(serverUid: string, actor?: { id: string; displayName: string }) {
  const server = await loadServer(serverUid);
  if (!INERT_STATES.includes(server.state)) {
    await stopServer(serverUid, {}, actor);
  }
  await startServer(serverUid, actor);
}

export async function sendConsoleCommand(serverUid: string, command: string): Promise<void> {
  const server = await loadServer(serverUid);
  if (server.state !== 'running' && server.state !== 'starting') {
    throw conflict('The server must be running before you can send commands.');
  }
  if (!server.containerId) throw conflict('This server has no running container.');

  const runtime = getRuntime(server.node);
  await runtime.writeStdin(server.containerId, `${command}\n`);
}

// ───────────────────────────────────────────────────────────────── deletion ──

export async function deleteServer(
  serverUid: string,
  actor: { id: string; displayName: string },
): Promise<void> {
  const server = await loadServer(serverUid);
  const runtime = getRuntime(server.node);

  await setServerState(serverUid, 'deleting');

  if (server.containerId) {
    await runtime.remove(server.containerId, { force: true }).catch((error) => {
      logger.warn({ error, serverUid }, 'container removal failed during delete');
    });
  }

  // Guard against a corrupt dataPath ever pointing somewhere catastrophic.
  const expected = path.join(server.node.dataRoot, server.uid);
  if (path.resolve(server.dataPath) === path.resolve(expected)) {
    await fs.rm(localDataPath(server.dataPath), { recursive: true, force: true }).catch((error) => {
      logger.error({ error, serverUid }, 'failed to remove server directory');
    });
  } else {
    logger.error(
      { serverUid, dataPath: server.dataPath, expected },
      'refusing to delete a data path that does not match the node layout',
    );
  }

  // Before the allocations go back in the pool: a forward pointing at a
  // recycled port would send strangers at whichever server claims it next.
  await closeGamePorts(serverUid).catch((error) =>
    logger.warn({ error, serverUid }, 'could not close forwarded ports during delete'),
  );

  await releaseAllocations(server.id);
  await prisma.server.delete({ where: { id: server.id } });

  const { recordAudit } = await import('../lib/events.js');
  await recordAudit({
    actorId: actor.id,
    action: 'server.delete',
    targetType: 'server',
    targetId: server.uid,
    metadata: { name: server.name, gameId: server.gameId },
  });
}

/**
 * Clones a stopped server: same game, settings and files, new ports and name.
 *
 * Worlds and mods are copied. Allocated ports differ, so settings are
 * re-applied afterwards so the game listens on the new allocations.
 */
export async function cloneServer(
  sourceUid: string,
  input: { name: string },
  actor: { id: string; displayName: string },
): Promise<Server> {
  const source = await loadServer(sourceUid);

  if (['running', 'starting', 'stopping', 'installing', 'updating', 'restoring', 'creating'].includes(source.state)) {
    throw conflict('Stop the server and wait for any jobs to finish before cloning it.');
  }
  if (!source.installedAt) {
    throw conflict('Finish installing this server before cloning it.');
  }

  const created = await createServer(
    {
      name: input.name,
      description: source.description ?? undefined,
      gameId: source.gameId,
      variantId: source.variantId,
      version: source.version,
      limits: {
        memoryMib: source.memoryMib,
        cpuCores: source.cpuCores,
        diskMib: source.diskMib,
        swapMib: source.swapMib,
        ioWeight: source.ioWeight,
      },
      settings: (source.settings ?? {}) as Record<string, string | number | boolean>,
      startOnCreate: false,
    },
    actor,
  );

  try {
    const from = localDataPath(source.dataPath);
    const to = localDataPath(created.dataPath);
    await fs.cp(from, to, { recursive: true, force: true });

    const fresh = await loadServer(created.uid);
    const adapter = getAdapter(fresh.gameId);
    const { createInstallTools } = await import('./install-tools.js');
    const tools = createInstallTools({
      dataPath: localDataPath(fresh.dataPath),
      runtime: getRuntime(fresh.node),
    });
    await adapter.applySettings(buildContext(fresh), tools);
    const { chownTreeForGame } = await import('../lib/ownership.js');
    await chownTreeForGame(localDataPath(fresh.dataPath));

    await prisma.server.update({
      where: { id: created.id },
      data: {
        state: 'offline',
        installedAt: new Date(),
        build: source.build,
        javaMajor: source.javaMajor,
      },
    });
  } catch (error) {
    await deleteServer(created.uid, actor).catch(() => undefined);
    throw conflict(
      'Could not copy the server files.',
      error instanceof Error ? error.message : 'Check disk space and try again.',
    );
  }

  await recordActivity({
    serverId: created.id,
    actorId: actor.id,
    actorName: actor.displayName,
    action: 'server.clone',
    message: `${actor.displayName} cloned this server from ${source.name}.`,
    metadata: { sourceUid },
  });

  return prisma.server.findUniqueOrThrow({ where: { id: created.id } });
}
