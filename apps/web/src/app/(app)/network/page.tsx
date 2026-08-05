'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Globe,
  House,
  Loader2,
  RefreshCw,
  Settings2,
  Shield,
  TriangleAlert,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { cn, timeAgo } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  useToast,
} from '@/components/ui';

/**
 * Network settings.
 *
 * The setup wizard answers "who can join" once; this is where that answer
 * lives afterwards — visible, checkable, and changeable. Without it the only
 * way back into setup is knowing the URL, which is not a thing to expect of
 * the person the wizard was written for.
 *
 * It deliberately shows *state* rather than re-implementing the wizard's
 * controls. Changing the answer means answering the question again, and one
 * implementation of that question is enough.
 */

interface NetworkReport {
  lanIp: string | null;
  vpn: { name: string; address: string; kind: string }[];
  router: { available: boolean; externalIp: string | null; controlUrl: string | null };
  reachability: 'public' | 'cgnat' | 'private' | 'unknown';
  forwardingEnabled: boolean;
  publicHost: string | null;
  gamePorts: number[];
  inContainer: boolean;
}

interface DdnsInfo {
  configured: boolean;
  provider: string | null;
  hostname: string | null;
  lastResult: { ok: boolean; message: string; at: string; ip?: string } | null;
}

export default function NetworkPage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const network = useQuery({
    queryKey: ['setup-network'],
    queryFn: () => api.get<NetworkReport>('/api/setup/network'),
    retry: false,
  });

  const ddns = useQuery({
    queryKey: ['setup-ddns'],
    queryFn: () => api.get<DdnsInfo>('/api/setup/ddns'),
    retry: false,
  });

  const refreshDns = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/api/setup/ddns/refresh'),
    onSuccess: (result) => {
      toast.push({ tone: result.ok ? 'ok' : 'danger', message: result.message });
      void queryClient.invalidateQueries({ queryKey: ['setup-ddns'] });
    },
  });

  const disableDns = useMutation({
    mutationFn: () => api.delete('/api/setup/ddns'),
    onSuccess: () => {
      toast.push({ tone: 'ok', message: 'Automatic DNS updates turned off' });
      void queryClient.invalidateQueries({ queryKey: ['setup-ddns'] });
    },
  });

  // Owners and admins only — the API says so too, so a subuser who guesses the
  // URL gets a 403 rather than a broken page.
  if (network.error instanceof ApiError && network.error.status === 403) {
    return (
      <div className="page-shell">
        <Card>
          <CardBody className="py-10 text-center">
            <p className="text-[13px] text-ink-muted">
              Only the panel owner can change network settings.
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  const report = network.data;
  const address = report?.publicHost
    ? report.gamePorts[0]
      ? `${report.publicHost}:${report.gamePorts[0]}`
      : report.publicHost
    : null;

  return (
    <div className="page-shell space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="legend mb-2">Panel</p>
          <h1 className="engraved text-lg sm:text-xl">Network</h1>
          <p className="mt-1.5 text-[13px] text-ink-muted">
            How players reach your servers, and what is opened to get them here.
          </p>
        </div>
        <Link href="/setup">
          <Button variant="primary">
            <Settings2 className="h-4 w-4" aria-hidden />
            Run setup again
          </Button>
        </Link>
      </div>

      {network.isLoading ? (
        <Skeleton className="h-44 w-full rounded-lg" />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Players connect to</CardTitle>
            <CardDescription>
              The address shown on every server page and copied by the address button.
            </CardDescription>
          </CardHeader>
          <CardBody className="space-y-4">
            {address ? (
              <code className="readout block w-full truncate px-3 py-2.5 text-[14px]">
                {address}
              </code>
            ) : (
              <p className="text-[13px] text-ink-subtle">No address is configured yet.</p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Fact
                icon={reachIcon(report)}
                label="Reach"
                value={reachLabel(report)}
                detail={reachDetail(report)}
              />
              <Fact
                icon={report?.forwardingEnabled ? Check : X}
                label="Router forwarding"
                value={report?.forwardingEnabled ? 'On' : 'Off'}
                detail={
                  report?.forwardingEnabled
                    ? 'The game port is opened while a server runs, and closed when it stops.'
                    : 'Nothing is opened automatically.'
                }
                tone={report?.forwardingEnabled ? 'ok' : 'muted'}
              />
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Automatic DNS updates</CardTitle>
          <CardDescription>
            Keeps your hostname pointed at this connection when your address changes.
          </CardDescription>
        </CardHeader>
        <CardBody className="space-y-4">
          {ddns.isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : ddns.data?.configured ? (
            <>
              <div className="flex flex-wrap items-center gap-2.5">
                <code className="readout px-2.5 py-1.5 text-[12.5px]">{ddns.data.hostname}</code>
                <Badge tone="neutral">{ddns.data.provider}</Badge>
              </div>

              {ddns.data.lastResult && (
                <div
                  className={cn(
                    'flex items-start gap-2.5 rounded-md border px-3.5 py-3',
                    ddns.data.lastResult.ok
                      ? 'border-ok/30 bg-ok/[0.07]'
                      : 'border-danger/30 bg-danger/[0.07]',
                  )}
                >
                  {ddns.data.lastResult.ok ? (
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
                  ) : (
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
                  )}
                  <p className="text-[12.5px] leading-relaxed text-ink-muted">
                    {ddns.data.lastResult.message}{' '}
                    <span className="text-ink-subtle">
                      Last checked {timeAgo(ddns.data.lastResult.at)}
                      {ddns.data.lastResult.ip ? ` · published ${ddns.data.lastResult.ip}` : ''}.
                    </span>
                  </p>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  loading={refreshDns.isPending}
                  loadingText="Publishing…"
                  onClick={() => refreshDns.mutate()}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  Update now
                </Button>
                <Button
                  variant="ghost"
                  loading={disableDns.isPending}
                  onClick={() => disableDns.mutate()}
                >
                  Turn off
                </Button>
              </div>
            </>
          ) : (
            <p className="text-[13px] leading-relaxed text-ink-muted">
              Not set up. If your home address changes, the name your players saved stops
              working — run setup again to have {'ServerForge'} keep it current.
            </p>
          )}
        </CardBody>
      </Card>

      {network.isLoading ? null : (
        <Card>
          <CardHeader>
            <CardTitle>What was detected</CardTitle>
            <CardDescription>
              Read from this machine and your router. Nothing here is sent anywhere.
            </CardDescription>
          </CardHeader>
          <CardBody className="space-y-2.5">
            <Row label="Local network address" value={report?.lanIp ?? 'not detected'} />
            {report?.vpn.map((entry) => (
              <Row key={entry.name} label={`VPN (${entry.kind})`} value={entry.address} />
            ))}
            <Row
              label="Address from router"
              value={report?.router.externalIp ?? 'not available'}
            />
            <Row
              label="Router automation"
              value={
                report?.router.available
                  ? 'Available'
                  : report?.inContainer
                    ? 'Not reachable from inside the container'
                    : 'Not available'
              }
            />
            {report?.gamePorts.length ? (
              <Row label="Game ports in use" value={report.gamePorts.join(', ')} />
            ) : null}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function reachIcon(report: NetworkReport | undefined) {
  if (!report?.publicHost) return Globe;
  if (report.publicHost === report.lanIp) return House;
  if (report.vpn.some((entry) => entry.address === report.publicHost)) return Shield;
  return Globe;
}

function reachLabel(report: NetworkReport | undefined): string {
  if (!report?.publicHost) return 'Not set';
  if (report.publicHost === report.lanIp) return 'Your network only';
  if (report.vpn.some((entry) => entry.address === report.publicHost)) return 'Private network';
  return 'The internet';
}

function reachDetail(report: NetworkReport | undefined): string {
  if (!report?.publicHost) return 'Run setup to choose who can join.';
  if (report.publicHost === report.lanIp) return 'Only people on your home network can join.';
  if (report.vpn.some((entry) => entry.address === report.publicHost)) {
    return 'Only people you have invited to your VPN can join.';
  }
  return 'Anyone with the address can try to connect.';
}

function Fact({
  icon: Icon,
  label,
  value,
  detail,
  tone = 'default',
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  detail: string;
  tone?: 'default' | 'ok' | 'muted';
}) {
  return (
    <div className="inset-well p-3.5">
      <span className="legend flex items-center gap-1.5">
        <Icon
          className={cn('h-3 w-3 shrink-0', tone === 'ok' ? 'text-ok' : 'text-ink-subtle')}
          aria-hidden
        />
        {label}
      </span>
      <p className="mt-2 text-[13px] font-medium text-ink">{value}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-subtle">{detail}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-[12.5px]">
      <span className="shrink-0 text-ink-subtle">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-[12px] text-ink">{value}</span>
    </div>
  );
}
