'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Check,
  Copy,
  Globe,
  House,
  Loader2,
  Shield,
  TriangleAlert,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { BRAND, cn, copyToClipboard } from '@/lib/utils';
import { Button, Card, CardBody, Field, Input, Select, Toggle, useToast } from '@/components/ui';

/**
 * First-run setup.
 *
 * One question, asked once: *who should be able to join your servers?* Every
 * other networking decision the panel needs — which address to hand players,
 * whether to ask the router to open a port — follows from the answer, so the
 * user never has to know the words "NAT", "UPnP" or "public host".
 *
 * The safe answer is the default. Nothing is exposed to the internet unless
 * somebody deliberately picks the option that says so, in those words.
 */

type ReachMode = 'lan' | 'vpn' | 'public';

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

interface Applied {
  publicHost: string;
  forwarding: boolean;
  gamePorts: number[];
  ddns: { ok: boolean; message: string; ip?: string } | null;
}

interface DdnsInfo {
  providers: {
    id: string;
    label: string;
    hostnameHint: string;
    tokenHint: string;
    consoleUrl: string;
  }[];
  configured: boolean;
  hostname: string | null;
}

export default function SetupPage() {
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ReachMode>('lan');
  const [customHost, setCustomHost] = useState('');
  const [applied, setApplied] = useState<Applied | null>(null);
  const [useDdns, setUseDdns] = useState(false);
  const [ddnsProvider, setDdnsProvider] = useState('duckdns');
  const [ddnsHostname, setDdnsHostname] = useState('');
  const [ddnsToken, setDdnsToken] = useState('');
  /** Prefill runs once; after that the form belongs to the user. */
  const prefilled = useRef(false);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () =>
      api.get<{ user: { displayName: string }; setupCompleted: boolean }>('/api/auth/me'),
    retry: false,
  });

  const network = useQuery({
    queryKey: ['setup-network'],
    queryFn: () => api.get<NetworkReport>('/api/setup/network'),
    retry: false,
    // Discovery talks to the router over the network; without this a remount
    // re-probes and the page appears to hang on an answer it already had.
    staleTime: 60_000,
  });

  const ddnsInfo = useQuery({
    queryKey: ['setup-ddns'],
    queryFn: () => api.get<DdnsInfo>('/api/setup/ddns'),
    retry: false,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) router.replace('/login');
  }, [me.error, router]);

  /**
   * Re-running setup should show the answer already in effect, not reset to
   * the default — otherwise "change my mind about one thing" reads as "start
   * from scratch and hope you remember what you picked".
   *
   * Gated on setup having been completed before, and on recognising the
   * stored address. On a genuine first run, and whenever the stored host
   * matches nothing, the safe local-only default stands: nothing here may
   * quietly pre-select exposing the server to the internet.
   */
  useEffect(() => {
    if (prefilled.current) return;
    if (!me.data?.setupCompleted || !network.data || !ddnsInfo.data) return;
    prefilled.current = true;

    const report = network.data;
    if (ddnsInfo.data.configured) {
      setMode('public');
      setUseDdns(true);
      if (ddnsInfo.data.hostname) setDdnsHostname(ddnsInfo.data.hostname);
      return;
    }
    if (report.publicHost && report.publicHost === report.lanIp) {
      setMode('lan');
      return;
    }
    if (report.vpn.some((entry) => entry.address === report.publicHost)) {
      setMode('vpn');
      return;
    }
    if (report.publicHost && report.publicHost === report.router.externalIp) {
      setMode('public');
      setCustomHost('');
    }
  }, [me.data, network.data, ddnsInfo.data]);

  /**
   * The dashboard shell decides whether to show this wizard from the cached
   * `me` response. Without refetching it here, finishing setup navigates into
   * a shell still holding `setupCompleted: false`, which sends the user
   * straight back — a loop that only breaks when the cache goes stale.
   * Awaited, so the shell never renders against the stale value.
   */
  const refreshSession = () => queryClient.invalidateQueries({ queryKey: ['me'] });

  const save = useMutation({
    mutationFn: (body: {
      mode: ReachMode;
      host?: string;
      ddns?: { provider: string; hostname: string; token: string };
    }) => api.post<Applied>('/api/setup/network', body),
    onSuccess: async (result) => {
      // A rejected token means the hostname will never resolve, so stay put
      // and let it be corrected rather than declaring success and moving on.
      if (result.ddns && !result.ddns.ok) {
        toast.push({
          tone: 'danger',
          message: result.ddns.message,
          hint: 'Your address was saved, but the name is not being kept up to date yet.',
        });
        return;
      }
      await refreshSession();
      setApplied(result);
    },
    onError: (error) => {
      toast.push({
        tone: 'danger',
        message: error instanceof ApiError ? error.body.message : 'Could not save that.',
        ...(error instanceof ApiError && error.body.hint ? { hint: error.body.hint } : {}),
      });
    },
  });

  const skip = useMutation({
    mutationFn: () => api.post('/api/setup/skip'),
    onSuccess: async () => {
      await refreshSession();
      router.replace('/servers');
    },
  });

  if (me.isLoading || network.isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center gap-2.5">
        <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />
        <span className="text-[13px] text-ink-subtle">Looking at your network…</span>
        <span className="sr-only">Detecting network settings</span>
      </main>
    );
  }

  const report = network.data;

  if (applied) {
    return <Finished applied={applied} onDone={() => router.replace('/servers')} toastCopy={toast} />;
  }

  const canUseVpn = (report?.vpn.length ?? 0) > 0;
  const publicBlocked = report?.reachability === 'cgnat' || report?.reachability === 'private';
  const activeProvider = ddnsInfo.data?.providers.find((entry) => entry.id === ddnsProvider);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-4 py-12">
      <header className="mb-7">
        <p className="legend mb-2">{BRAND.name} setup</p>
        <h1 className="engraved text-2xl">Who should be able to join?</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-muted">
          This decides the address {BRAND.name} gives your players. You can change it
          later at any time — nothing here is permanent.
        </p>
      </header>

      <div className="space-y-2.5" role="radiogroup" aria-label="Who should be able to join">
        <Choice
          icon={House}
          selected={mode === 'lan'}
          onSelect={() => setMode('lan')}
          title="Just my own network"
          badge="Recommended"
          summary="People on your home Wi-Fi can join. Nothing is opened to the internet."
          detail={
            report?.lanIp ? (
              <>
                Players will use <Mono>{report.lanIp}</Mono>
              </>
            ) : (
              'No local address detected — pick another option.'
            )
          }
          disabled={!report?.lanIp}
        />

        {canUseVpn && (
          <Choice
            icon={Shield}
            selected={mode === 'vpn'}
            onSelect={() => setMode('vpn')}
            title="Friends on my private network"
            summary={`Anyone you invite to your ${report?.vpn[0]?.kind === 'tailscale' ? 'Tailscale' : 'VPN'} network can join, from anywhere. Still nothing opened to the internet.`}
            detail={
              <>
                Players will use <Mono>{report?.vpn[0]?.address}</Mono>{' '}
                <span className="text-ink-subtle">
                  (via {report?.vpn[0]?.name}) — they need to install it too
                </span>
              </>
            }
          />
        )}

        <Choice
          icon={Globe}
          selected={mode === 'public'}
          onSelect={() => setMode('public')}
          title="Anyone on the internet"
          summary="Your server becomes reachable by anyone who has the address."
          tone={publicBlocked ? 'warn' : 'default'}
          detail={<PublicDetail report={report} />}
          disabled={publicBlocked}
        />
      </div>

      {mode === 'public' && !publicBlocked && (
        <Card className="mt-3">
          <CardBody className="space-y-3">
            {!useDdns && (
              <Field
                label="Custom address"
                help="Optional. Leave empty to use the address your router reported."
              >
                <Input
                  value={customHost}
                  onChange={(event) => setCustomHost(event.target.value)}
                  placeholder={report?.router.externalIp ?? 'play.example.com'}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </Field>
            )}

            {/*
              Home connections get a new address every so often, which silently
              breaks every saved link. Offering to maintain it here is the
              difference between "works today" and "works next month".
            */}
            <div className="flex items-start justify-between gap-4 border-t border-line pt-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-ink">Keep the address up to date</p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
                  Your home address changes from time to time. {BRAND.name} can publish the
                  new one automatically so the name your players saved keeps working.
                </p>
              </div>
              <Toggle
                checked={useDdns}
                onChange={setUseDdns}
                label="Keep the address up to date automatically"
              />
            </div>

            {useDdns && (
              <div className="space-y-3">
                <Field label="Provider">
                  <Select
                    value={ddnsProvider}
                    onChange={(event) => setDdnsProvider(event.target.value)}
                  >
                    {(ddnsInfo.data?.providers ?? []).map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field
                  label="Hostname"
                  help={activeProvider?.hostnameHint ?? 'The name you registered.'}
                  required
                >
                  <Input
                    value={ddnsHostname}
                    onChange={(event) => setDdnsHostname(event.target.value)}
                    placeholder="myserver.duckdns.org"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </Field>

                <Field
                  label="Token"
                  help={
                    ddnsInfo.data?.configured
                      ? 'Leave blank to keep the token you already saved.'
                      : (activeProvider?.tokenHint ?? 'From your account.')
                  }
                  required={!ddnsInfo.data?.configured}
                >
                  <Input
                    type="password"
                    value={ddnsToken}
                    onChange={(event) => setDdnsToken(event.target.value)}
                    placeholder={ddnsInfo.data?.configured ? '••••••••  (unchanged)' : undefined}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>

                <p className="text-[12px] leading-relaxed text-ink-subtle">
                  The token is stored encrypted and never shown again. It is checked the
                  moment you continue — if it is wrong, you will be told here rather than
                  finding out when nobody can connect.
                </p>
              </div>
            )}

            <div className="flex items-start gap-2.5 rounded-md border border-warn/30 bg-warn/[0.07] px-3.5 py-3">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
              <p className="text-[12.5px] leading-relaxed text-ink-muted">
                Anyone who finds the address can try to connect. Turn on a whitelist in
                your server&apos;s settings, and keep it updated.{' '}
                {report?.router.available
                  ? 'Only the port players connect on is opened — never the remote console.'
                  : 'Your router did not answer automatic setup, so you will need to forward the port yourself.'}
              </p>
            </div>
          </CardBody>
        </Card>
      )}

      <div className="mt-6 flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={() => skip.mutate()} loading={skip.isPending}>
          Skip for now
        </Button>
        <Button
          variant="primary"
          size="lg"
          loading={save.isPending}
          loadingText="Setting up…"
          onClick={() =>
            save.mutate({
              mode,
              ...(mode === 'public' && !useDdns && customHost.trim()
                ? { host: customHost.trim() }
                : {}),
              ...(mode === 'vpn' && report?.vpn[0] ? { host: report.vpn[0].address } : {}),
              ...(mode === 'public' && useDdns
                ? {
                    ddns: {
                      provider: ddnsProvider,
                      hostname: ddnsHostname.trim(),
                      token: ddnsToken,
                    },
                  }
                : {}),
            })
          }
        >
          Continue
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </main>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[12.5px] text-ink">{children}</span>;
}

function PublicDetail({ report }: { report: NetworkReport | undefined }) {
  if (!report) return null;

  if (report.reachability === 'cgnat') {
    return (
      <>
        Not possible on this connection. Your internet provider shares one address between
        many homes, so incoming connections cannot reach you.{' '}
        <span className="text-ink-subtle">
          A private network is the way to play with friends from outside.
        </span>
      </>
    );
  }

  // Inside a container the router is not absent, only unreachable from here.
  // Saying "your router does not support this" would be plainly wrong.
  if (!report.router.available && report.inContainer) {
    return (
      <>
        {BRAND.name} is running inside a container, so it cannot see your router from
        there. You can still choose this — you will just need to forward the port on the
        router yourself, or set <Mono>UPNP_CONTROL_URL</Mono> to let the panel do it.
      </>
    );
  }

  if (report.reachability === 'private' || report.reachability === 'unknown') {
    return (
      <>
        Could not confirm this is possible — your router reported{' '}
        <Mono>{report.router.externalIp ?? 'no address'}</Mono>, which is not reachable from
        the internet.
      </>
    );
  }

  return (
    <>
      Players will use <Mono>{report.router.externalIp}</Mono>.{' '}
      {report.router.available ? (
        <span className="text-ok">Your router supports opening the port automatically.</span>
      ) : (
        <span className="text-warn">
          Your router did not answer, so you will need to forward the port by hand.
        </span>
      )}
    </>
  );
}

function Choice({
  icon: Icon,
  title,
  badge,
  summary,
  detail,
  selected,
  onSelect,
  disabled,
  tone = 'default',
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  badge?: string;
  summary: string;
  detail: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  tone?: 'default' | 'warn';
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'card w-full p-4 text-left transition-colors',
        selected ? 'border-accent bg-accent/[0.06]' : 'hover:border-line-strong',
        disabled && 'cursor-not-allowed opacity-60 hover:border-line',
      )}
    >
      <div className="flex items-start gap-3.5">
        <span
          className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            selected ? 'bg-accent text-accent-ink' : 'bg-surface-raised text-ink-subtle',
          )}
          aria-hidden
        >
          <Icon className="h-4 w-4" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="engraved text-[14px]">{title}</span>
            {badge && (
              <span className="rounded-full border border-ok/30 bg-ok/10 px-2 py-0.5 text-[11px] font-medium text-ok">
                {badge}
              </span>
            )}
          </span>
          <span className="mt-1 block text-[13px] leading-relaxed text-ink-muted">{summary}</span>
          <span
            className={cn(
              'mt-2 block text-[12.5px] leading-relaxed',
              tone === 'warn' ? 'text-ink-muted' : 'text-ink-muted',
            )}
          >
            {detail}
          </span>
        </span>

        {selected && <Check className="mt-1 h-4 w-4 shrink-0 text-accent" aria-hidden />}
      </div>
    </button>
  );
}

function Finished({
  applied,
  onDone,
  toastCopy,
}: {
  applied: Applied;
  onDone: () => void;
  toastCopy: ReturnType<typeof useToast>;
}) {
  const port = applied.gamePorts[0];
  const address = port ? `${applied.publicHost}:${port}` : applied.publicHost;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center px-4 py-12">
      <div className="mb-6 flex flex-col items-center text-center">
        <span
          className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-ok/15 text-ok"
          aria-hidden
        >
          <Check className="h-5 w-5" />
        </span>
        <h1 className="engraved text-xl">You&apos;re set up</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-muted">
          {applied.forwarding
            ? 'Your router will be opened automatically each time a server starts, and closed again when it stops.'
            : 'Nothing has been opened to the internet.'}
        </p>
      </div>

      <Card>
        <CardBody className="space-y-3">
          <p className="legend">Players connect to</p>
          <div className="flex items-center gap-2">
            <code className="readout min-w-0 flex-1 truncate px-3 py-2 text-[13px]">{address}</code>
            <Button
              variant="secondary"
              size="icon"
              aria-label="Copy address"
              onClick={async () => {
                const ok = await copyToClipboard(address);
                toastCopy.push({
                  tone: ok ? 'ok' : 'danger',
                  message: ok ? 'Address copied' : 'Could not copy',
                });
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          {!port && (
            <p className="text-[12.5px] leading-relaxed text-ink-subtle">
              Each server gets its own port number, added to this address when you create one.
            </p>
          )}
        </CardBody>
      </Card>

      <Button variant="primary" size="lg" className="mt-5 w-full" onClick={onDone}>
        Create your first server
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Button>
    </main>
  );
}
