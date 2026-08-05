/**
 * Port mapping.
 *
 * Kept in its own module with no imports so it stays pure and directly
 * testable — the rest of the server service pulls in configuration, Docker
 * and Prisma, none of which this needs.
 */

export interface DeclaredPort {
  containerPort: number;
  purpose: string;
  protocol: 'tcp' | 'udp';
  /** True only for a game whose listening port cannot be configured. */
  fixed?: boolean;
}

export interface PortAllocationLike {
  ip: string;
  port: number;
  purpose: string;
}

export interface PortBinding {
  hostIp: string;
  hostPort: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
}

/**
 * Turns an adapter's declared ports into concrete Docker port bindings.
 *
 * The container port must be the port the game actually listens on. Because
 * `applySettings` writes the *allocated* port into the game's own config, the
 * mapping is host N -> container N.
 *
 * Publishing host N -> container 25565 while the game listens on N produces a
 * server that reports itself online, accepts console commands (those go over
 * stdin, not TCP), and refuses every player connection — the client sees only
 * "connection refused: getsockopt". Loopback hides it further, because
 * docker-proxy accepts the connection before failing to forward it.
 */
export function mapPorts(
  declared: DeclaredPort[],
  allocations: PortAllocationLike[],
): PortBinding[] {
  const bindings: PortBinding[] = [];

  for (const port of declared) {
    const allocation = allocations.find((a) => a.purpose === port.purpose);
    if (!allocation) continue;

    bindings.push({
      hostIp: allocation.ip,
      hostPort: allocation.port,
      containerPort: port.fixed ? port.containerPort : allocation.port,
      protocol: port.protocol,
    });
  }

  return bindings;
}

/**
 * The subset of ports it is safe to expose to the internet.
 *
 * Only `game` — the port a player's client connects to. An adapter also
 * declares `rcon` (a remote console that runs arbitrary server commands),
 * `query` and sometimes `rest`; those are LAN- and localhost-shaped services
 * that happen to sit on adjacent port numbers, and forwarding a whole range
 * would publish them by accident.
 *
 * This lives here, next to the mapping it filters, so the rule is visible to
 * anyone reading how ports are assigned — and so it is testable without
 * dragging in configuration, Docker or the router client.
 */
export function forwardablePorts(
  declared: DeclaredPort[],
  allocations: PortAllocationLike[],
): PortBinding[] {
  return mapPorts(
    declared.filter((port) => port.purpose === 'game'),
    allocations,
  );
}
