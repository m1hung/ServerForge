export interface DeclaredPort {
  containerPort: number;
  purpose: string;
  protocol: 'tcp' | 'udp';
  fixed?: boolean;
}

export interface PortBinding {
  hostIp: string;
  hostPort: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
}

export function mapPorts(
  declared: DeclaredPort[],
  allocations: { ip: string; port: number; purpose: string }[],
): PortBinding[] {
  const bindings: PortBinding[] = [];
  for (const port of declared) {
    const allocation = allocations.find((row) => row.purpose === port.purpose);
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

/** Only the game port is ever handed to UPnP — never rcon, query, or rest. */
export function forwardablePorts(
  declared: DeclaredPort[],
  allocations: { ip: string; port: number; purpose: string }[],
): PortBinding[] {
  return mapPorts(
    declared.filter((port) => port.purpose === 'game'),
    allocations,
  );
}
