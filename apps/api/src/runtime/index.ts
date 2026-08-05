import { AppError } from '@serverforge/core';
import { config } from '../config.js';
import { DockerRuntime } from './docker.js';
import type { RuntimeDriver } from './types.js';

export type { RuntimeDriver, ContainerSpec, ContainerStatus } from './types.js';

/**
 * Runtime driver factory.
 *
 * One driver instance per node, cached — dockerode holds a connection pool
 * and creating one per request would leak sockets.
 */
const drivers = new Map<string, RuntimeDriver>();

export interface NodeLike {
  id: string;
  transport: string;
  agentUrl: string | null;
}

export function getRuntime(node: NodeLike): RuntimeDriver {
  const cached = drivers.get(node.id);
  if (cached) return cached;

  let driver: RuntimeDriver;
  switch (node.transport) {
    case 'docker':
      driver = new DockerRuntime(config.DOCKER_SOCKET);
      break;
    case 'agent':
      // Remote nodes are the next milestone: the interface is already shaped
      // for it, so this is a wiring job rather than a redesign.
      throw new AppError(501, 'not_implemented', 'Remote nodes are not available yet.', {
        hint: 'Run servers on the local machine for now.',
      });
    default:
      throw new AppError(500, 'bad_node', `Unknown node transport "${node.transport}".`);
  }

  drivers.set(node.id, driver);
  return driver;
}

/** Local driver, for boot-time reconciliation before any node is loaded. */
export function localRuntime(): RuntimeDriver {
  return getRuntime({ id: '__local__', transport: 'docker', agentUrl: null });
}
