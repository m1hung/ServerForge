export type Server = {
  uid: string;
  name: string;
  description?: string | null;
  canConfigure?: boolean;
  permissions?: string[];
  busy?: boolean;
  state: string;
  containerId?: string | null;
  console?: { canRead: boolean; acceptsCommands: boolean; note?: string };
  gameId: string;
  variantId: string;
  version: string;
  memoryMib: number;
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
        `${server.name} ${server.gameId} ${server.variantId} ${joinAddress(server) ?? ''}`
          .toLowerCase()
          .includes(search)) &&
      (status === 'all' ||
        (status === 'attention'
          ? statusTone(server.state) === 'danger'
          : server.state === status)) &&
      (game === 'all' || server.gameId === game),
  );
}
