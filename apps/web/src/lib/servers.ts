import type { Preferences } from './preferences';

export type Server = {
  uid: string;
  name: string;
  description?: string | null;
  canConfigure?: boolean;
  permissions?: string[];
  busy?: boolean;
  state: string;
  containerId?: string | null;
  console?: {
    canRead: boolean;
    acceptsCommands: boolean;
    note?: string;
    commands?: { command: string; summary: string; category: string }[];
  };
  gameId: string;
  variantId: string;
  version: string;
  memoryMib: number;
  swapMib?: number | null;
  ioWeight?: number | null;
  cpuCores: number;
  diskMib: number;
  allocations: { port: number; primary: boolean; purpose: string }[];
  node: { name: string; publicHost: string };
};

export function statusTone(state: string) {
  if (state === 'running') return 'success';
  if (['crashed', 'install_failed', 'error'].includes(state)) return 'danger';
  if (['installing', 'starting', 'stopping', 'restoring', 'updating'].includes(state))
    return 'warning';
  return 'neutral';
}

export function displayName(value: string) {
  return value.replace(/[_-]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function memoryLabel(mib: number) {
  return mib === 0 ? 'Unlimited' : `${Number((mib / 1024).toFixed(1))} GiB`;
}

export function joinAddress(server: Server) {
  const port = server.allocations.find((allocation) => allocation.primary)?.port;
  const host = server.node?.publicHost;
  return port && host
    ? `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`
    : null;
}

export function filterServers(servers: Server[], query: string, status: string, game: string) {
  const search = query.trim().toLowerCase();
  return servers.filter(
    (server) =>
      (!search ||
        `${server.name} ${server.description ?? ''} ${displayName(server.gameId)} ${server.gameId} ${server.variantId} ${joinAddress(server) ?? ''}`
          .toLowerCase()
          .includes(search)) &&
      (status === 'all' ||
        (status === 'attention'
          ? statusTone(server.state) === 'danger'
          : server.state === status)) &&
      (game === 'all' || server.gameId === game),
  );
}

export function sortServers(
  servers: Server[],
  sort: Preferences['serverSort'],
  favorites: string[],
) {
  const starred = new Set(favorites);
  const rank = (server: Server) =>
    sort === 'favorites'
      ? Number(starred.has(server.uid))
      : sort === 'running'
        ? Number(server.state === 'running')
        : sort === 'attention'
          ? Number(statusTone(server.state) === 'danger')
          : 0;
  return [...servers].sort(
    (a, b) =>
      rank(b) - rank(a) ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) ||
      a.uid.localeCompare(b.uid),
  );
}
