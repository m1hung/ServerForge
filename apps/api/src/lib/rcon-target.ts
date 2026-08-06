import { existsSync } from 'node:fs';
import type { StartupPlan } from '@serverforge/adapters';

/**
 * Where this process can reach a game server's RCON port.
 *
 * The answer depends on where the panel itself is running, and both shapes are
 * normal:
 *
 *   - **On the host** (`npm run dev`): the game container publishes its port,
 *     so the host side of the mapping is reachable on loopback.
 *   - **In a container** (the compose stack): published host ports are not
 *     reachable from inside another container on any platform worth relying
 *     on. But game containers share a Docker network, and Docker resolves
 *     container names on it — so the panel talks to the container directly,
 *     on the *container* side of the mapping.
 *
 * Which is why the compose file puts the API on the games network.
 */

/** Docker creates this in every container it runs. */
function runningInContainer(): boolean {
  return existsSync('/.dockerenv');
}

export interface RconTarget {
  host: string;
  port: number;
}

/**
 * Resolves the address, or null when this server has no usable RCON.
 *
 * Returning null rather than throwing is deliberate: the caller falls back to
 * stdin, which is what a game supporting both should do before RCON is set up.
 */
export function resolveRconTarget(input: {
  plan: StartupPlan;
  containerName: string;
  allocations: { ip: string; port: number; purpose: string }[];
  settings: Record<string, unknown>;
  /** Overrides container detection. Only for tests and odd deployments. */
  inContainer?: boolean;
}): RconTarget | null {
  const console_ = input.plan.console;
  if (!console_ || console_.transport !== 'rcon') return null;

  // An explicit "off" switch means off, whatever else is configured.
  if (console_.enabledSetting && input.settings[console_.enabledSetting] !== true) return null;

  // No password is not a misconfiguration to shout about — it is simply a
  // server whose owner has not set RCON up yet.
  const password = String(input.settings[console_.passwordSetting] ?? '');
  if (password.trim() === '') return null;

  const allocation = input.allocations.find((a) => a.purpose === console_.portPurpose);
  if (!allocation) return null;

  const inContainer = input.inContainer ?? runningInContainer();

  if (inContainer) {
    // Container side of the mapping. Equal to the allocated port unless the
    // adapter pinned it with `fixed`, which is for games whose listening port
    // cannot be configured — see StartupPlan.ports.
    const mapping = input.plan.ports.find((p) => p.purpose === console_.portPurpose);
    const port = mapping?.fixed ? mapping.containerPort : allocation.port;
    return { host: input.containerName, port };
  }

  // Host side. A specific bind address is where the port actually is;
  // 0.0.0.0 means every interface, of which loopback is the one we want.
  const host = allocation.ip && allocation.ip !== '0.0.0.0' ? allocation.ip : '127.0.0.1';
  return { host, port: allocation.port };
}

/** Reads the password for a plan's console, or empty when there is none. */
export function rconPassword(plan: StartupPlan, settings: Record<string, unknown>): string {
  if (!plan.console) return '';
  return String(settings[plan.console.passwordSetting] ?? '');
}
