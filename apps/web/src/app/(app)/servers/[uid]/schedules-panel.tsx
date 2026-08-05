'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Pencil, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { timeAgo } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Toggle,
  useToast,
} from '@/components/ui';

/**
 * Scheduled tasks.
 *
 * Cron is the storage format, not the interface. Almost every schedule anyone
 * actually wants is one of four shapes, so those are buttons and the raw
 * expression is the escape hatch — and whichever route you take, the panel
 * says back in words when it will next run.
 */

type ActionType = 'power' | 'command' | 'backup';

type ScheduleAction =
  | { type: 'power'; action: 'start' | 'stop' | 'restart' }
  | { type: 'command'; command: string }
  | { type: 'backup'; retain: number };

interface Schedule {
  uid: string;
  name: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  onlyWhenOnline: boolean;
  actions: ScheduleAction[];
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  lastRunError: string | null;
  nextRunAt: string | null;
}

const PRESETS = [
  { label: 'Every day at 4am', cron: '0 4 * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Every Sunday at 4am', cron: '0 4 * * 0' },
  { label: 'Every hour', cron: '0 * * * *' },
] as const;

const DEFAULT_ACTION: Record<ActionType, ScheduleAction> = {
  power: { type: 'power', action: 'restart' },
  command: { type: 'command', command: 'say Server restarting in 60 seconds' },
  backup: { type: 'backup', retain: 5 },
};

/** The browser's zone, so "4am" means 4am where the person reading it lives. */
function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function describeAction(action: ScheduleAction): string {
  switch (action.type) {
    case 'power':
      return `${action.action[0].toUpperCase()}${action.action.slice(1)} the server`;
    case 'command':
      return `Run “${action.command}”`;
    case 'backup':
      return `Back up, keeping the newest ${action.retain}`;
  }
}

function describeCron(cron: string): string {
  const preset = PRESETS.find((p) => p.cron === cron);
  return preset ? preset.label.toLowerCase() : cron;
}

function formatNextRun(iso: string | null): string {
  if (!iso) return 'not scheduled';
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
  });
}

export function SchedulesPanel({ uid, permissions }: { uid: string; permissions: string[] }) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);

  const canManage = permissions.includes('server.schedules');

  const schedules = useQuery({
    queryKey: ['schedules', uid],
    queryFn: () => api.get<{ schedules: Schedule[] }>(`/api/servers/${uid}/schedules`),
  });

  const onError = (error: unknown) => {
    if (error instanceof ApiError) {
      toast.push({ tone: 'danger', message: error.body.message, hint: error.body.hint });
    }
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['schedules', uid] });

  const toggle = useMutation({
    mutationFn: (schedule: Schedule) =>
      api.patch(`/api/servers/${uid}/schedules/${schedule.uid}`, { enabled: !schedule.enabled }),
    onSuccess: (_result, schedule) => {
      toast.push({
        tone: 'ok',
        message: `${schedule.name} ${schedule.enabled ? 'paused' : 'resumed'}.`,
      });
      refresh();
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (scheduleUid: string) => api.delete(`/api/servers/${uid}/schedules/${scheduleUid}`),
    onSuccess: () => {
      toast.push({ tone: 'ok', message: 'Schedule deleted.' });
      setDeleting(null);
      refresh();
    },
    onError,
  });

  if (schedules.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  const list = schedules.data?.schedules ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-[13px] text-ink-muted">
          {list.length === 0
            ? 'Nothing scheduled.'
            : `${list.length} schedule${list.length === 1 ? '' : 's'}.`}{' '}
          Tasks run on the panel, so they still happen when nobody is signed in.
        </p>
        {canManage && (
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" aria-hidden />
            New schedule
          </Button>
        )}
      </div>

      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon={CalendarClock}
            title="No scheduled tasks"
            description="A nightly restart keeps memory use down, and a nightly backup means the worst thing that can happen is losing a day. Both take about thirty seconds to set up."
            action={
              canManage ? (
                <Button variant="primary" onClick={() => setEditing('new')}>
                  Create a schedule
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {list.map((schedule) => (
              <li key={schedule.uid} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-ink">
                      {schedule.name}
                    </span>
                    {!schedule.enabled && <Badge tone="neutral">Paused</Badge>}
                    {schedule.lastRunOk === false && <Badge tone="danger">Last run failed</Badge>}
                  </div>
                  <p className="mt-0.5 text-[11.5px] text-ink-subtle">
                    {describeCron(schedule.cron)} · {schedule.timezone}
                    {schedule.enabled && ` · next ${formatNextRun(schedule.nextRunAt)}`}
                    {schedule.lastRunAt && ` · last ran ${timeAgo(schedule.lastRunAt)}`}
                  </p>
                  <p className="mt-1 text-[12px] text-ink-muted">
                    {schedule.actions.map(describeAction).join(', then ')}
                    {schedule.onlyWhenOnline && ' — only while the server is running'}
                  </p>
                  {schedule.lastRunError && (
                    <p className="mt-1 text-[12px] text-danger">{schedule.lastRunError}</p>
                  )}
                </div>

                {canManage && (
                  <div className="flex shrink-0 items-center gap-2">
                    <Toggle
                      checked={schedule.enabled}
                      onChange={() => toggle.mutate(schedule)}
                      label={`${schedule.enabled ? 'Pause' : 'Resume'} ${schedule.name}`}
                      disabled={toggle.isPending}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Edit"
                      aria-label={`Edit ${schedule.name}`}
                      onClick={() => setEditing(schedule)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Delete"
                      aria-label={`Delete ${schedule.name}`}
                      onClick={() => setDeleting(schedule)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {editing && (
        <ScheduleEditor
          uid={uid}
          schedule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
          onError={onError}
        />
      )}

      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete "${deleting?.name}"?`}
        description="The schedule stops running. Anything it already did stays."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.uid)}
            >
              Delete schedule
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-ink-muted">
          If you only want to stop it for a while, pause it instead — that keeps the settings.
        </p>
      </Modal>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── editor ──

function ScheduleEditor({
  uid,
  schedule,
  onClose,
  onSaved,
  onError,
}: {
  uid: string;
  schedule: Schedule | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState(schedule?.name ?? 'Nightly restart');
  const [cron, setCron] = useState(schedule?.cron ?? PRESETS[0].cron);
  const [custom, setCustom] = useState(
    schedule ? !PRESETS.some((p) => p.cron === schedule.cron) : false,
  );
  const [timezone] = useState(schedule?.timezone ?? localZone());
  const [onlyWhenOnline, setOnlyWhenOnline] = useState(schedule?.onlyWhenOnline ?? true);
  const [actions, setActions] = useState<ScheduleAction[]>(
    schedule?.actions ?? [DEFAULT_ACTION.power],
  );

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        cron: cron.trim(),
        timezone,
        enabled: schedule?.enabled ?? true,
        onlyWhenOnline,
        actions,
      };
      return schedule
        ? api.patch(`/api/servers/${uid}/schedules/${schedule.uid}`, body)
        : api.post(`/api/servers/${uid}/schedules`, body);
    },
    onSuccess: onSaved,
    onError,
  });

  const setAction = (index: number, next: ScheduleAction) =>
    setActions((current) => current.map((a, i) => (i === index ? next : a)));

  const fieldIssue = (key: string) =>
    save.error instanceof ApiError
      ? save.error.fieldIssues.find((issue) => issue.key === key)?.message
      : undefined;

  return (
    <Modal
      open
      onClose={onClose}
      title={schedule ? `Edit "${schedule.name}"` : 'New schedule'}
      description="Runs on the panel's clock, in the timezone shown below."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!name.trim() || actions.length === 0}
            onClick={() => save.mutate()}
          >
            {schedule ? 'Save changes' : 'Create schedule'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Name" required error={fieldIssue('name')}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            placeholder="Nightly restart"
            data-autofocus
          />
        </Field>

        <div className="space-y-2">
          <p className="legend text-ink-muted">When</p>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <button
                key={preset.cron}
                type="button"
                onClick={() => {
                  setCron(preset.cron);
                  setCustom(false);
                }}
                className={
                  !custom && cron === preset.cron
                    ? 'rounded-lg border border-accent bg-accent/10 px-3 py-1.5 text-[12.5px] text-accent'
                    : 'rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-[12.5px] text-ink-muted hover:border-line-strong hover:text-ink'
                }
              >
                {preset.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setCustom(true)}
              className={
                custom
                  ? 'rounded-lg border border-accent bg-accent/10 px-3 py-1.5 text-[12.5px] text-accent'
                  : 'rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-[12.5px] text-ink-muted hover:border-line-strong hover:text-ink'
              }
            >
              Custom…
            </button>
          </div>

          {custom && (
            <Field
              label="Cron expression"
              help="Five fields: minute, hour, day of month, month, day of week. “30 5 * * 1” is 5:30am every Monday."
              error={fieldIssue('cron')}
            >
              <Input
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="0 4 * * *"
              />
            </Field>
          )}

          <p className="text-[12px] text-ink-subtle">
            Times are in <span className="text-ink-muted">{timezone}</span>.
          </p>
        </div>

        {/* ── Actions ──────────────────────────────────────────────────── */}
        <div className="space-y-2">
          <p className="legend text-ink-muted">Do this</p>
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            Steps run in order, top to bottom. A warning command before a restart gives players time
            to get somewhere safe.
          </p>

          <div className="space-y-2">
            {actions.map((action, index) => (
              <div
                key={index}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2.5"
              >
                <Select
                  className="w-32"
                  aria-label={`Step ${index + 1} type`}
                  value={action.type}
                  onChange={(e) => setAction(index, DEFAULT_ACTION[e.target.value as ActionType])}
                >
                  <option value="power">Power</option>
                  <option value="command">Command</option>
                  <option value="backup">Backup</option>
                </Select>

                {action.type === 'power' && (
                  <Select
                    className="w-32"
                    aria-label={`Step ${index + 1} power action`}
                    value={action.action}
                    onChange={(e) =>
                      setAction(index, {
                        type: 'power',
                        action: e.target.value as 'start' | 'stop' | 'restart',
                      })
                    }
                  >
                    <option value="restart">Restart</option>
                    <option value="start">Start</option>
                    <option value="stop">Stop</option>
                  </Select>
                )}

                {action.type === 'command' && (
                  <Input
                    className="min-w-0 flex-1"
                    aria-label={`Step ${index + 1} command`}
                    value={action.command}
                    maxLength={1024}
                    onChange={(e) => setAction(index, { type: 'command', command: e.target.value })}
                    placeholder="say Restarting in 60 seconds"
                  />
                )}

                {action.type === 'backup' && (
                  <label className="flex items-center gap-2 text-[12.5px] text-ink-muted">
                    keep newest
                    <Input
                      className="w-16"
                      type="number"
                      min={1}
                      max={50}
                      aria-label={`Step ${index + 1} backups to keep`}
                      value={action.retain}
                      onChange={(e) =>
                        setAction(index, {
                          type: 'backup',
                          retain: Math.min(Math.max(Number(e.target.value) || 1, 1), 50),
                        })
                      }
                    />
                  </label>
                )}

                {actions.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Remove step"
                    aria-label={`Remove step ${index + 1}`}
                    onClick={() => setActions((current) => current.filter((_, i) => i !== index))}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>

          {actions.length < 10 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setActions((current) => [...current, DEFAULT_ACTION.command])}
            >
              <Plus className="h-4 w-4" aria-hidden />
              Add a step
            </Button>
          )}
        </div>

        <div className="flex items-start justify-between gap-4 border-t border-line pt-4">
          <div>
            <p className="text-[13px] text-ink">Only run while the server is online</p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-muted">
              Leave this on for restarts and commands. Turn it off if you want backups to happen
              even when the server is stopped.
            </p>
          </div>
          <Toggle
            checked={onlyWhenOnline}
            onChange={setOnlyWhenOnline}
            label="Only run while the server is online"
          />
        </div>

        {actions.some((a) => a.type === 'power' && a.action !== 'start') && (
          <div className="flex items-start gap-2.5 rounded-lg border border-warn/30 bg-warn/10 px-4 py-3">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
            <p className="text-[12.5px] leading-relaxed text-ink-muted">
              This disconnects everyone playing at the time. Pick an hour when the server is usually
              quiet.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
