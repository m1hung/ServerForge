'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Copy, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { formatMib } from '@/lib/utils';
import {
  Button,
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Modal,
  Textarea,
  useToast,
} from '@/components/ui';
import type { ServerState } from '@/components/server-status';

/**
 * Renaming, resizing, updating, cloning and deleting a server.
 *
 * Kept apart from the game settings panel because these are panel-level
 * properties rather than anything the game itself reads, and because deletion
 * needs to sit well away from a form people save often.
 */

export interface GeneralPanelServer {
  uid: string;
  name: string;
  description: string | null;
  state: ServerState;
  version: string;
  gameName: string;
  limits: { memoryMib: number; cpuCores: number; diskMib: number };
  permissions: string[];
}

export function GeneralPanel({ server }: { server: GeneralPanelServer }) {
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description ?? '');
  const [limits, setLimits] = useState(server.limits);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneName, setCloneName] = useState(`${server.name} copy`);

  const canEdit = server.permissions.includes('server.settings');
  const canDelete = server.permissions.includes('server.delete');

  const isLive = ['running', 'starting'].includes(server.state);
  const isBusy = ['installing', 'creating', 'updating', 'restoring', 'deleting'].includes(
    server.state,
  );

  const dirty =
    name !== server.name ||
    description !== (server.description ?? '') ||
    limits.memoryMib !== server.limits.memoryMib ||
    limits.cpuCores !== server.limits.cpuCores ||
    limits.diskMib !== server.limits.diskMib;

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/servers/${server.uid}`, {
        name,
        description: description.trim() === '' ? null : description.trim(),
        limits: {
          memoryMib: limits.memoryMib,
          cpuCores: limits.cpuCores,
          diskMib: limits.diskMib,
        },
      }),
    onSuccess: () => {
      setErrors({});
      toast.push({
        tone: 'ok',
        message: 'Saved',
        hint: isLive ? 'New limits applied to the running server.' : undefined,
      });
      queryClient.invalidateQueries({ queryKey: ['server', server.uid] });
      queryClient.invalidateQueries({ queryKey: ['servers'] });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        const next: Record<string, string> = {};
        for (const issue of error.fieldIssues) next[issue.key] = issue.message;
        setErrors(next);
        toast.push({ tone: 'danger', message: error.body.message, hint: error.body.hint });
      }
    },
  });

  const updateGame = useMutation({
    mutationFn: () => api.post(`/api/servers/${server.uid}/update`, { startAfter: false }),
    onSuccess: (result: { message?: string }) => {
      setConfirmUpdate(false);
      toast.push({ tone: 'ok', message: result.message ?? 'Update started.' });
      queryClient.invalidateQueries({ queryKey: ['server', server.uid] });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        toast.push({ tone: 'danger', message: error.body.message, hint: error.body.hint });
      }
    },
  });

  const clone = useMutation({
    mutationFn: () =>
      api.post<{ server: { uid: string } }>(`/api/servers/${server.uid}/clone`, {
        name: cloneName.trim(),
      }),
    onSuccess: (result) => {
      setCloneOpen(false);
      toast.push({ tone: 'ok', message: 'Server cloned.' });
      queryClient.invalidateQueries({ queryKey: ['servers'] });
      router.push(`/servers/${result.server.uid}`);
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        toast.push({ tone: 'danger', message: error.body.message, hint: error.body.hint });
      }
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/servers/${server.uid}`),
    onSuccess: () => {
      toast.push({ tone: 'ok', message: `"${server.name}" was deleted.` });
      queryClient.invalidateQueries({ queryKey: ['servers'] });
      router.push('/servers');
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        toast.push({ tone: 'danger', message: error.body.message, hint: error.body.hint });
      }
    },
  });

  return (
    <div className="space-y-4 pb-24">
      <Card>
        <CardHeader>
          <CardTitle>Server details</CardTitle>
          <CardDescription>Only you see these — they are not shown to players.</CardDescription>
        </CardHeader>
        <CardBody className="space-y-5">
          <Field
            label="Name"
            help="What this server is called in your dashboard."
            error={errors.name}
            required
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={48}
              disabled={!canEdit}
            />
          </Field>

          <Field label="Description" help="An optional note about what this server is for.">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={2}
              disabled={!canEdit}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Resources</CardTitle>
          <CardDescription>
            {isLive
              ? 'Memory and CPU changes apply immediately — no restart needed.'
              : 'Applied the next time the server starts.'}
          </CardDescription>
        </CardHeader>
        <CardBody className="space-y-5">
          <Field
            label="Memory"
            help="Too little and the server crashes under load. Java servers also need headroom above the heap, which we account for automatically."
            error={errors.memoryMib}
          >
            <Slider
              value={limits.memoryMib}
              min={1024}
              max={32768}
              step={512}
              format={formatMib}
              disabled={!canEdit}
              onChange={(memoryMib) => setLimits({ ...limits, memoryMib })}
              label="Memory in megabytes"
            />
          </Field>

          <Field
            label="CPU cores"
            help="Most game servers use one core heavily and a second for background work."
          >
            <Slider
              value={limits.cpuCores}
              min={1}
              max={16}
              step={0.5}
              format={(v) => String(v)}
              disabled={!canEdit}
              onChange={(cpuCores) => setLimits({ ...limits, cpuCores })}
              label="CPU cores"
            />
          </Field>

          <Field
            label="Disk"
            help="The server is stopped if it exceeds this, so it cannot fill the machine's disk and take other servers down with it."
          >
            <Slider
              value={limits.diskMib}
              min={2048}
              max={204800}
              step={1024}
              format={formatMib}
              disabled={!canEdit}
              onChange={(diskMib) => setLimits({ ...limits, diskMib })}
              label="Disk in megabytes"
            />
          </Field>
        </CardBody>
      </Card>

      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle>Maintenance</CardTitle>
            <CardDescription>
              Update game files from upstream, or clone this server onto a fresh port.
            </CardDescription>
          </CardHeader>
          <CardBody className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={isBusy || isLive}
              onClick={() => setConfirmUpdate(true)}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Update {server.gameName}
            </Button>
            <Button
              variant="secondary"
              disabled={isBusy || isLive}
              onClick={() => {
                setCloneName(`${server.name} copy`);
                setCloneOpen(true);
              }}
            >
              <Copy className="h-4 w-4" aria-hidden />
              Clone server
            </Button>
            {(isBusy || isLive) && (
              <p className="basis-full text-[12.5px] text-ink-muted">
                {isLive
                  ? 'Stop the server before updating or cloning.'
                  : 'Wait for the current job to finish first.'}
              </p>
            )}
          </CardBody>
        </Card>
      )}

      {canDelete && (
        <Card className="border-danger/40">
          <CardHeader>
            <CardTitle className="text-danger">Delete this server</CardTitle>
            <CardDescription>
              The world, configuration, mods and every backup are removed from the disk. This
              cannot be undone.
            </CardDescription>
          </CardHeader>
          <CardBody>
            <Button variant="danger" onClick={() => setConfirmDelete(true)} disabled={isBusy}>
              <Trash2 className="h-4 w-4" aria-hidden />
              Delete server
            </Button>
            {isBusy && (
              <p className="mt-2 text-[12.5px] text-ink-muted">
                Wait for the current job to finish first.
              </p>
            )}
          </CardBody>
        </Card>
      )}

      {dirty && canEdit && (
        <div className="fixed bottom-0 left-0 right-0 z-30 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur md:left-60">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
            <p className="text-[12.5px] text-ink-muted">Unsaved changes</p>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setName(server.name);
                  setDescription(server.description ?? '');
                  setLimits(server.limits);
                  setErrors({});
                }}
              >
                Discard
              </Button>
              <Button
                variant="primary"
                loading={save.isPending}
                loadingText="Saving…"
                onClick={() => save.mutate()}
              >
                <Save className="h-4 w-4" aria-hidden />
                Save changes
              </Button>
            </div>
          </div>
        </div>
      )}

      <Modal
        open={confirmUpdate}
        onClose={() => setConfirmUpdate(false)}
        title={`Update ${server.gameName}?`}
        description="Downloads the latest server files. Your world and settings are kept."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmUpdate(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={updateGame.isPending}
              loadingText="Starting…"
              onClick={() => updateGame.mutate()}
            >
              Update now
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Current version label: <span className="font-medium text-ink">{server.version}</span>.
          Steam games refresh from the public branch; Minecraft reinstalls the selected build.
        </p>
      </Modal>

      <Modal
        open={cloneOpen}
        onClose={() => setCloneOpen(false)}
        title="Clone this server"
        description="Copies the world, mods and settings onto a new server with its own ports."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCloneOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={clone.isPending}
              loadingText="Cloning…"
              disabled={cloneName.trim().length < 2}
              onClick={() => clone.mutate()}
            >
              Clone
            </Button>
          </>
        }
      >
        <Field label="Name for the copy" required>
          <Input
            value={cloneName}
            onChange={(e) => setCloneName(e.target.value)}
            maxLength={48}
            autoFocus
          />
        </Field>
      </Modal>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete "${server.name}"?`}
        description="This removes the server and everything in it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              loadingText="Deleting…"
              onClick={() => remove.mutate()}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <div className="flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
          <div className="text-[12.5px] leading-relaxed text-ink-muted">
            <p className="font-medium text-ink">Everything below is deleted:</p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
              <li>The world and all player data</li>
              <li>Configuration, mods and plugins</li>
              <li>Every backup of this server</li>
            </ul>
            <p className="mt-2">Download a backup first if you might want any of it later.</p>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** Range input with a live readout, matching the deploy wizard. */
function Slider({
  value,
  min,
  max,
  step,
  format,
  disabled,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  disabled?: boolean;
  onChange: (v: number) => void;
  label: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[12.5px]">
        <span className="text-ink-muted">{label}</span>
        <span className="font-medium tabular-nums text-ink">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-accent"
      />
    </div>
  );
}
