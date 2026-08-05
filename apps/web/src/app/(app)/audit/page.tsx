'use client';

import { useQuery } from '@tanstack/react-query';
import { ScrollText, Search } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { timeAgo } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Input,
  Select,
  Skeleton,
} from '@/components/ui';

/**
 * Audit log.
 *
 * Who changed what, in words. The stored `action` is a dotted key because
 * that is what a log should be greppable by; every one of them gets a
 * sentence here, because "user.update" tells the person reading it nothing
 * they came here to find out.
 *
 * An unrecognised action still renders — falling back to the raw key beats
 * hiding an event nobody wrote a sentence for yet.
 */

interface AuditEntry {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  at: string;
  actor: { displayName: string; username: string } | null;
}

const ACTION_TEXT: Record<string, string> = {
  'user.create': 'created an account',
  'user.update': 'changed an account',
  'apikey.create': 'created an API key',
  'node.update': 'changed a machine',
  'settings.update': 'changed a panel setting',
  'server.create': 'created a server',
  'server.delete': 'deleted a server',
  'auth.login': 'signed in',
  'auth.logout': 'signed out',
  'auth.password': 'changed their password',
};

/** Destructive and permission-granting actions are the ones worth spotting. */
const NOTABLE = ['delete', 'suspend', 'role', 'apikey'];

function tone(action: string): 'neutral' | 'warn' | 'danger' {
  if (action.includes('delete')) return 'danger';
  if (NOTABLE.some((word) => action.includes(word))) return 'warn';
  return 'neutral';
}

function describe(entry: AuditEntry): string {
  const who = entry.actor?.displayName ?? 'Someone no longer on this panel';
  const what = ACTION_TEXT[entry.action] ?? entry.action;
  return `${who} ${what}`;
}

/** The bits of metadata worth showing inline, rendered as `key: value`. */
function summarise(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const parts = Object.entries(metadata)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}: ${String(value)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export default function AuditPage() {
  const [limit, setLimit] = useState('100');
  const [filter, setFilter] = useState('');

  const audit = useQuery({
    queryKey: ['admin-audit', limit],
    queryFn: () => api.get<{ entries: AuditEntry[] }>(`/api/admin/audit?limit=${limit}`),
    retry: false,
  });

  if (audit.error instanceof ApiError && audit.error.status === 403) {
    return (
      <div className="page-shell">
        <Card>
          <CardBody className="py-10 text-center">
            <p className="text-[13px] text-ink-muted">
              Only the panel owner and administrators can read the audit log.
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  const term = filter.trim().toLowerCase();
  const entries = (audit.data?.entries ?? []).filter((entry) =>
    term === ''
      ? true
      : `${describe(entry)} ${entry.action} ${entry.targetType} ${entry.actor?.username ?? ''}`
          .toLowerCase()
          .includes(term),
  );

  return (
    <div className="page-shell space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="legend mb-2">Panel</p>
          <h1 className="engraved text-lg sm:text-xl">Audit log</h1>
          <p className="mt-1.5 text-[13px] text-ink-muted">
            Changes to accounts, machines, keys and panel settings. What happens on a single server
            is on that server&apos;s own activity list.
          </p>
        </div>
        <div className="flex shrink-0 items-end gap-2">
          <Input
            className="w-52"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            aria-label="Filter the audit log"
          />
          <Select
            className="w-28"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            aria-label="How many entries to load"
          >
            <option value="100">Last 100</option>
            <option value="250">Last 250</option>
            <option value="500">Last 500</option>
          </Select>
        </div>
      </div>

      {audit.isLoading ? (
        <Skeleton className="h-64 w-full rounded-lg" />
      ) : entries.length === 0 ? (
        <Card>
          <EmptyState
            icon={term ? Search : ScrollText}
            title={term ? 'Nothing matches that' : 'Nothing recorded yet'}
            description={
              term
                ? 'Try a person’s name, or part of an action like “delete”.'
                : 'Account changes, API keys and machine edits will appear here as they happen.'
            }
            action={
              term ? (
                <Button variant="secondary" onClick={() => setFilter('')}>
                  Clear the filter
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {entries.map((entry) => {
              const detail = summarise(entry.metadata);

              return (
                <li key={entry.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] text-ink">{describe(entry)}</span>
                      <Badge tone={tone(entry.action)}>{entry.action}</Badge>
                    </div>
                    <p className="mt-0.5 font-mono text-[11.5px] text-ink-subtle">
                      {entry.targetType}
                      {entry.targetId && ` ${entry.targetId}`}
                      {entry.ip && ` · from ${entry.ip}`}
                    </p>
                    {detail && <p className="mt-1 text-[12px] text-ink-muted">{detail}</p>}
                  </div>
                  <time
                    className="shrink-0 text-[11.5px] text-ink-subtle"
                    dateTime={entry.at}
                    title={new Date(entry.at).toLocaleString()}
                  >
                    {timeAgo(entry.at)}
                  </time>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <p className="text-[12.5px] text-ink-subtle">
        Entries are kept indefinitely and cannot be edited or removed from the panel.
      </p>
    </div>
  );
}
