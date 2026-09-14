'use client';

import { useEffect, useState } from 'react';
import type { ResourceUsage } from '@serverforge/core';
import { formatBytes, formatDuration } from '@serverforge/core/format';
import { api } from '@/lib/api';
import { memoryLabel, type Server } from '@/lib/servers';
import { Icon, type IconName } from './Icon';
import { CpuUsage } from './CpuUsage';

type Reading = {
  usage: ResourceUsage | null;
  containerId: string | null;
  diskBytes: number | null;
};
type Sample = ResourceUsage & { rxRate: number | null; txRate: number | null };

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="resource-sparkline" />;
  const max = Math.max(...values, 1);
  const points = values
    .map((value, i) => `${(i * 200) / (values.length - 1)},${30 - (value / max) * 26}`)
    .join(' ');
  return (
    <svg
      className="resource-sparkline"
      viewBox="0 0 200 34"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function ServerResources({ server }: { server: Server }) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [status, setStatus] = useState('Connecting to resource monitor…');
  const [available, setAvailable] = useState(false);
  const [diskBytes, setDiskBytes] = useState<number | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    let previous: Reading | undefined;
    setSamples([]);
    setAvailable(false);
    setDiskBytes(null);
    setStatus('Connecting to resource monitor…');
    const poll = async () => {
      const started = Date.now();
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const next = await api<Reading>(`/api/servers/${server.uid}/resources`, {
          signal: controller.signal,
        });
        if (disposed) return;
        const usage = next.usage;
        setDiskBytes(next.diskBytes ?? null);
        setAvailable(!!usage);
        setStatus(
          usage
            ? 'Live · updates every 2 seconds'
            : 'Server offline · resource monitoring resumes when it starts',
        );
        if (usage) {
          const last = previous?.containerId === next.containerId ? previous.usage : null;
          const elapsed = last ? (usage.timestamp - last.timestamp) / 1000 : 0;
          const continuous = last && elapsed > 0 && usage.uptimeSeconds >= last.uptimeSeconds;
          const sample: Sample = {
            ...usage,
            rxRate: continuous
              ? Math.max(0, usage.networkRxBytes - last.networkRxBytes) / elapsed
              : null,
            txRate: continuous
              ? Math.max(0, usage.networkTxBytes - last.networkTxBytes) / elapsed
              : null,
          };
          setSamples((history) => [...(continuous ? history : []), sample].slice(-40));
        } else setSamples([]);
        previous = next;
      } catch {
        if (disposed) return;
        setAvailable(false);
        setStatus('Live readings unavailable · retrying automatically');
        previous = undefined;
      } finally {
        clearTimeout(timeout);
        if (!disposed)
          timer = setTimeout(() => void poll(), Math.max(0, 2000 - (Date.now() - started)));
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [server.uid, server.containerId, server.state]);

  const usage = available ? samples.at(-1) : undefined;
  const memoryLimit = usage?.memoryLimitBytes ?? server.memoryMib * 1024 ** 2;
  const cards: {
    label: string;
    value: string;
    detail: string;
    icon: IconName;
    values?: number[];
    percent?: number;
  }[] = [
    {
      label: 'Memory usage',
      icon: 'memory',
      value: usage ? formatBytes(usage.memoryBytes) : '—',
      detail: server.memoryMib
        ? `of ${memoryLimit ? formatBytes(memoryLimit) : memoryLabel(server.memoryMib)}`
        : 'No memory limit · excluding file cache',
      values: usage ? samples.map((s) => s.memoryBytes) : [],
      percent: usage && memoryLimit ? (usage.memoryBytes / memoryLimit) * 100 : undefined,
    },
    {
      label: 'Network',
      icon: 'activity',
      value: usage?.rxRate != null ? `${formatBytes(usage.rxRate)}/s` : '—',
      detail:
        usage?.txRate != null
          ? `↓ Inbound · ↑ ${formatBytes(usage.txRate)}/s outbound`
          : 'Inbound / outbound traffic',
      values: usage ? samples.map((s) => s.rxRate ?? 0) : [],
    },
    {
      label: 'Uptime',
      icon: 'server',
      value: usage ? formatDuration(usage.uptimeSeconds) : '—',
      detail: 'Since the last server start',
    },
  ];

  return (
    <section className="resource-monitor" aria-label="Live server resources">
      <div className="resource-monitor-heading">
        <h2>Resource usage</h2>
        <span className={usage ? 'resource-live' : ''} role="status">
          <span className="status-dot" />
          {status}
        </span>
      </div>
      <CpuUsage usage={usage} configuredCores={server.cpuCores} />
      <div className="live-resource-grid">
        {cards.map((card) => (
          <div className="resource-card" key={card.label}>
            <div className="resource-card-label">
              <Icon name={card.icon} size={16} />
              {card.label}
            </div>
            <strong>{card.value}</strong>
            <p>{card.detail}</p>
            {card.values && <Sparkline values={card.values} />}
            {card.percent !== undefined && (
              <div
                className="resource-meter"
                role="meter"
                aria-label={`${card.label} as percentage of limit`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(Math.min(100, card.percent))}
              >
                <span style={{ width: `${Math.min(100, card.percent)}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
        Storage: {diskBytes === null ? 'measurement unavailable' : formatBytes(diskBytes)}
        {' · '}
        {server.diskMib ? `${formatBytes(server.diskMib * 1024 ** 2)} budget` : 'No storage budget'}
        {' · Measured approximately every minute; this is not a disk quota.'}
      </p>
    </section>
  );
}
