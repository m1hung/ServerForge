import type { StartupPlan } from '@serverforge/adapters';

export function resolveRconTarget(input: {
  plan: StartupPlan;
  containerName: string;
  allocations: { ip: string; port: number; purpose: string }[];
  settings: Record<string, unknown>;
  inContainer: boolean;
}): { host: string; port: number } | null {
  const consoleSpec = input.plan.console;
  if (!consoleSpec || consoleSpec.transport !== 'rcon') return null;

  if (consoleSpec.enabledSetting) {
    if (input.settings[consoleSpec.enabledSetting] !== true) return null;
  }

  const password = String(input.settings[consoleSpec.passwordSetting] ?? '').trim();
  if (password === '') return null;

  const allocation = input.allocations.find((row) => row.purpose === consoleSpec.portPurpose);
  if (!allocation) return null;

  const declared = input.plan.ports.find((port) => port.purpose === consoleSpec.portPurpose);
  const port = input.inContainer && declared?.fixed ? declared.containerPort : allocation.port;

  if (input.inContainer) {
    return { host: input.containerName, port };
  }

  const host = allocation.ip && allocation.ip !== '0.0.0.0' && allocation.ip !== '::' ? allocation.ip : '127.0.0.1';
  return { host, port };
}
