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
 *
 * A task can also run on something the server did rather than on the clock.
 * The two are exclusive: picking one clears the other, because a task with
 * both would fire from two directions with no sensible ordering.
 */

type ActionType = 'power' | 'command' | 'backup' | 'update' | 'webhook';

type TriggerType =
  | 'player.join'
  | 'player.leave'
  | 'server.ready'
  | 'server.crashed'
  | 'server.stopped';

type ScheduleAction =
  | { type: 'power'; action: 'start' | 'stop' | 'restart' }
  | { type: 'command'; command: string }
  | { type: 'backup'; retain: number }
  | { type: 'update'; startAfter: boolean }
  | { type: 'webhook'; url: string; template: string; format: 'discord' | 'json' };

interface Schedule {
  uid: string;
  name: string;
  cron: string | null;
  triggerType: TriggerType | null;
  cooldownSeconds: number;
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

const TRIGGERS: { value: TriggerType; label: string; hint: string }[] = [
  {
    value: 'player.join',
    label: 'A player joins',
    hint: 'Fires once per player. Use a cooldown so a full server does not fire it repeatedly.',
  },
  { value: 'player.leave', label: 'A player leaves', hint: 'Fires once per player.' },
  {
    value: 'server.ready',
    label: 'The server finishes starting',
    hint: 'After the game reports itself ready, not when the container starts.',
  },
  {
    value: 'server.crashed',
    label: 'The server crashes',
    hint: 'An unexpected exit, including running out of memory.',
  },
  { value: 'server.stopped', label: 'The server stops', hint: 'Any clean shutdown.' },
];

/** Triggers that only happen while the server is not running. */
const OFFLINE_TRIGGERS = new Set<TriggerType>(['server.crashed', 'server.stopped']);

const COOLDOWNS = [
  { value: 0, label: 'No cooldown' },
  { value: 60, label: '1 minute' },
  { value: 300, label: '5 minutes' },
  { value: 1800, label: '30 minutes' },
  { value: 3600, label: '1 hour' },
  { value: 21_600, label: '6 hours' },
] as const;

const DEFAULT_ACTION: Record<ActionType, ScheduleAction> = {
  power: { type: 'power', action: 'restart' },
  command: { type: 'command', command: 'say Server restarting in 60 seconds' },
  backup: { type: 'backup', retain: 5 },
  update: { type: 'update', startAfter: true },
  webhook: {
    type: 'webhook',
    url: '',
    template: '{player} joined {server}',
    format: 'discord',
  },
};

/** Placeholders `renderTemplate` understands, for the hint under the field. */
const PLACEHOLDERS = '{server} {player} {event} {task}';

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
    case 'update':
      return action.startAfter
        ? 'Update game files, then start'
        : 'Update game files';
    case 'webhook': {
      let host = action.url;
      try {
        host = new URL(action.url).host;
      } catch {
        // An unparseable URL is shown as typed — the API refused it anyway.
      }
      return `Send a message to ${host}`;
    }
  }
}

function describeCron(cron: string): string {
  const preset = PRESETS.find((p) => p.cron === cron);
  return preset ? preset.label.toLowerCase() : cron;
}

function describeCooldown(seconds: number): string {
  const preset = COOLDOWNS.find((c) => c.value === seconds);
  if (preset) return preset.label.toLowerCase();
  return `${seconds}s cooldown`;
}

/** The "when" line under a schedule's name, for either kind. */
function describeTiming(schedule: Schedule): string {
  if (schedule.triggerType) {
    const trigger = TRIGGERS.find((t) => t.value === schedule.triggerType);
    const label = trigger ? trigger.label.toLowerCase() : schedule.triggerType;
    return schedule.cooldownSeconds > 0
      ? `when ${label} · ${describeCooldown(schedule.cooldownSeconds)}`
      : `when ${label}`;
  }
  if (schedule.cron) return `${describeCron(schedule.cron)} · ${schedule.timezone}`;
  return 'never — no time or event set';
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
                    {describeTiming(schedule)}
                    {schedule.enabled &&
                      !schedule.triggerType &&
                      ` · next ${formatNextRun(schedule.nextRunAt)}`}
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
  const [mode, setMode] = useState<'time' | 'event'>(schedule?.triggerType ? 'event' : 'time');
  const [cron, setCron] = useState(schedule?.cron ?? PRESETS[0].cron);
  const [custom, setCustom] = useState(
    schedule?.cron ? !PRESETS.some((p) => p.cron === schedule.cron) : false,
  );
  const [triggerType, setTriggerType] = useState<TriggerType>(
    schedule?.triggerType ?? 'player.join',
  );
  const [cooldownSeconds, setCooldownSeconds] = useState(schedule?.cooldownSeconds ?? 300);
  const [timezone] = useState(schedule?.timezone ?? localZone());
  const [onlyWhenOnline, setOnlyWhenOnline] = useState(schedule?.onlyWhenOnline ?? true);
  const [actions, setActions] = useState<ScheduleAction[]>(
    schedule?.actions ?? [DEFAULT_ACTION.power],
  );

  // "Only while online" plus a trigger that only fires when the server is not
  // running is a task that can never run. The API rejects it; the form simply
  // does not let it be built.
  const forcedOffline = mode === 'event' && OFFLINE_TRIGGERS.has(triggerType);
  const effectiveOnlyWhenOnline = forcedOffline ? false : onlyWhenOnline;

  // A webhook step with no address would be a 422 on save. Catch it here so
  // the button is simply unavailable instead.
  const incompleteWebhook = actions.some(
    (action) => action.type === 'webhook' && action.url.trim() === '',
  );

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        // Both are always sent, so switching mode clears the other side.
        cron: mode === 'time' ? cron.trim() : null,
        triggerType: mode === 'event' ? triggerType : null,
        cooldownSeconds: mode === 'event' ? cooldownSeconds : 0,
        timezone,
        enabled: schedule?.enabled ?? true,
        onlyWhenOnline: effectiveOnlyWhenOnline,
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
            disabled={!name.trim() || actions.length === 0 || incompleteWebhook}
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

          <div className="flex gap-2">
            {(
              [
                { value: 'time', label: 'On a repeating time' },
                { value: 'event', label: 'When something happens' },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setMode(option.value)}
                className={
                  mode === option.value
                    ? 'flex-1 rounded-lg border border-accent bg-accent/10 px-3 py-2 text-[12.5px] text-accent'
                    : 'flex-1 rounded-lg border border-line bg-surface-raised px-3 py-2 text-[12.5px] text-ink-muted hover:border-line-strong hover:text-ink'
                }
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {mode === 'event' ? (
          <div className="space-y-3">
            <Field label="Run this when" error={fieldIssue('triggerType')}>
              <Select
                value={triggerType}
                onChange={(e) => setTriggerType(e.target.value as TriggerType)}
              >
                {TRIGGERS.map((trigger) => (
                  <option key={trigger.value} value={trigger.value}>
                    {trigger.label}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="text-[12px] leading-relaxed text-ink-subtle">
              {TRIGGERS.find((t) => t.value === triggerType)?.hint}
            </p>

            <Field
              label="Wait before it can run again"
              help="Ignores the event while the last run is still inside this window."
              error={fieldIssue('cooldownSeconds')}
            >
              <Select
                value={String(cooldownSeconds)}
                onChange={(e) => setCooldownSeconds(Number(e.target.value))}
              >
                {COOLDOWNS.map((cooldown) => (
                  <option key={cooldown.value} value={cooldown.value}>
                    {cooldown.label}
                  </option>
                ))}
              </Select>
            </Field>

            {cooldownSeconds === 0 && actions.some((a) => a.type === 'backup') && (
              <div className="flex items-start gap-2.5 rounded-lg border border-warn/30 bg-warn/10 px-4 py-3">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
                <p className="text-[12.5px] leading-relaxed text-ink-muted">
                  Backing up with no cooldown means ten players joining produces ten backups. Pick a
                  cooldown unless you are sure.
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2">
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
        )}

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
                  <option value="update">Update</option>
                  <option value="webhook">Webhook</option>
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

                {action.type === 'update' && (
                  <label className="flex items-center gap-2 text-[12.5px] text-ink-muted">
                    <input
                      type="checkbox"
                      checked={action.startAfter}
                      onChange={(e) =>
                        setAction(index, { type: 'update', startAfter: e.target.checked })
                      }
                    />
                    Start after update
                  </label>
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

                {action.type === 'webhook' && (
                  <div className="flex w-full min-w-0 flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        className="min-w-0 flex-1"
                        aria-label={`Step ${index + 1} webhook address`}
                        value={action.url}
                        maxLength={2048}
                        onChange={(e) => setAction(index, { ...action, url: e.target.value })}
                        placeholder="https://discord.com/api/webhooks/…"
                      />
                      <Select
                        className="w-28"
                        aria-label={`Step ${index + 1} webhook format`}
                        value={action.format}
                        onChange={(e) =>
                          setAction(index, {
                            ...action,
                            format: e.target.value as 'discord' | 'json',
                          })
                        }
                      >
                        <option value="discord">Discord</option>
                        <option value="json">Plain JSON</option>
                      </Select>
                    </div>
                    <Input
                      aria-label={`Step ${index + 1} message`}
                      value={action.template}
                      maxLength={1024}
                      onChange={(e) => setAction(index, { ...action, template: e.target.value })}
                      placeholder="{player} joined {server}"
                    />
                    <p className="text-[11.5px] text-ink-subtle">
                      Placeholders: <span className="text-ink-muted">{PLACEHOLDERS}</span>. The
                      panel sends this itself, so the address has to be reachable from the internet
                      — not a machine on your LAN.
                    </p>
                  </div>
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
              {forcedOffline
                ? 'Off, and locked: this event only happens when the server is not running, so the task would never get to run.'
                : 'Leave this on for restarts and commands. Turn it off if you want backups to happen even when the server is stopped.'}
            </p>
          </div>
          <Toggle
            checked={effectiveOnlyWhenOnline}
            onChange={setOnlyWhenOnline}
            disabled={forcedOffline}
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
