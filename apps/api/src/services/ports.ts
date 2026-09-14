export interface DeclaredPort {
  containerPort: number;
  purpose: string;
  protocol: 'tcp' | 'udp';
  fixed?: boolean;
  /** Public discovery traffic only; administration ports never qualify. */
  public?: boolean;
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
      hostIp: ['game', 'query'].includes(port.purpose) ? allocation.ip : '127.0.0.1',
      hostPort: allocation.port,
      containerPort: port.fixed ? port.containerPort : allocation.port,
      protocol: port.protocol,
    });
  }
  return bindings;
}

/** Game traffic and explicitly declared discovery ports only; never administration. */
export function forwardablePorts(
  declared: DeclaredPort[],
  allocations: { ip: string; port: number; purpose: string }[],
): PortBinding[] {
  return mapPorts(
    declared.filter(
      (port) => port.purpose === 'game' || (port.purpose === 'query' && port.public === true),
    ),
    allocations,
  );
}
