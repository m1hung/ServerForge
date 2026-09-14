export interface NetworkConfiguration {
  lanHost: string;
  publicHost: string;
  routerUrl: string;
  upnpEnabled: boolean;
  leaseSeconds: number;
  tailscaleMode: 'auto' | 'host' | 'sidecar';
  tailscaleUrl: string;
  tailscaleGameHost: string;
}

export interface HostNetworkSnapshot {
  checkedAt: string;
  lanHost: string | null;
  gateway: { controlUrl: string; serviceType: string } | null;
  tailscale: {
    state: string;
    ip: string | null;
    dnsName: string | null;
    dashboardUrl: string | null;
  } | null;
}

export interface PortForward {
  serverUid: string;
  serverName: string;
  port: number;
  protocol: 'TCP' | 'UDP';
  internalHost: string;
  controlUrl: string;
  serviceType: string;
  description: string;
  leaseSeconds: number;
  state: 'pending' | 'active' | 'conflict' | 'error' | 'removing';
  verifiedAt: string | null;
  error: string | null;
}

export interface TailnetStatus {
  mode: 'host' | 'sidecar';
  available: boolean;
  state: string;
  machineName: string | null;
  ip: string | null;
  dashboardUrl: string | null;
  /** Verified direct host dashboard URL over the encrypted tailnet, without HTTPS Serve. */
  directUrl?: string | null;
  loginUrl: string | null;
  httpsReady: boolean;
  serving: boolean;
  error: string | null;
}

export interface NetworkReport {
  configuration: NetworkConfiguration;
  checkedAt: string;
  hostDetectedAt: string | null;
  lanHost: string | null;
  publicHost: string | null;
  publicIp: string | null;
  router: {
    available: boolean;
    controlUrl: string | null;
    serviceType: string | null;
    externalIp: string | null;
    issue: string | null;
    behindNat: boolean;
  };
  tailscale: TailnetStatus;
  forwards: PortForward[];
  servers: { uid: string; name: string; state: string; publicAccess: boolean }[];
}

export interface ServerConnections {
  checkedAt: string;
  publicAccess: boolean;
  upnpEnabled: boolean;
  canManage: boolean;
  canConfigureNetwork: boolean;
  addresses: {
    kind: 'local' | 'public' | 'tailscale';
    label: string;
    address: string | null;
    host: string | null;
    note: string;
  }[];
  ports: { port: number; protocol: string; purpose: string }[];
  forwards: Pick<PortForward, 'port' | 'protocol' | 'state' | 'verifiedAt' | 'error'>[];
}

export function formatJoinAddress(host: string, port: number): string {
  return `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}
