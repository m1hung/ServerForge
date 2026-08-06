'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive, MemoryStick, Network, Pencil, Wrench } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { cn, formatMib } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Modal,
  Skeleton,
  Toggle,
  useToast,
} from '@/components/ui';

/**
 * Machines.
 *
 * One row per node. Today there is only ever the local one, but the numbers
 * that matter are the same either way: is it reachable, how much of it is
 * already promised to servers, and how many ports are left to hand out.
 *
 * Allocated is what has been *promised*, not what is in use — a stopped
 * server still holds its memory limit here, because starting it has to be
 * possible without asking anyone's permission.
 */

interface NodeCapacity {
  memoryMib: number;
  allocatedMemoryMib: number;
  diskMib: number;
  allocatedDiskMib: number;
  overheadPct: number;
}

interface PanelNode {
  uid: string;
  name: string;
  transport: string;
  publicHost: string | null;
  online: boolean;
  maintenance: boolean;
  portRange: string;
  freePorts: number;
  servers: number;
  capacity: NodeCapacity;
}

/** Usable capacity is the raw figure less the headroom reserved for the host. */
function usable(total: number, overheadPct: number): number {
  return Math.max(Math.round(total * (1 - overheadPct / 100)), 0);
}

function Meter({
  label,
  icon: Icon,
  used,
  total,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  used: number;
  total: number;
}) {
  const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  const tight = pct >= 90;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[12px] text-ink-muted">
          <Icon className="h-3.5 w-3.5 text-ink-subtle" />
          {label}
        </span>
        <span className="font-mono text-[11.5px] tabular-nums text-ink-subtle">
          {formatMib(used)} / {formatMib(total)}
        </span>
      </div>
      <div className="inset-well h-1.5 w-full overflow-hidden rounded-full">
        <div
          className={cn('h-full rounded-full', tight ? 'bg-warn' : 'bg-accent')}
          style={{ width: `${pct}%` }}
          role="meter"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label} allocated`}
        />
      </div>
    </div>
  );
}

export default function MachinesPage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState<PanelNode | null>(null);

  const nodes = useQuery({
    queryKey: ['admin-nodes'],
    queryFn: () => api.get<{ nodes: PanelNode[] }>('/api/admin/nodes'),
    retry: false,
    // Reachability is a live fact, and a node that just went down should not
    // keep looking healthy until someone reloads.
    refetchInterval: 30_000,
  });

  const onError = (error: unknown) => {
    if (error instanceof ApiError) {
      toast.push({ tone: 'danger', message: error.body.message, hint: error.body.hint });
    }
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-nodes'] });

  const setMaintenance = useMutation({
    mutationFn: ({ node, on }: { node: PanelNode; on: boolean }) =>
      api.patch(`/api/admin/nodes/${node.uid}`, { maintenance: on }),
    onSuccess: (_result, { node, on }) => {
      toast.push({
        tone: 'ok',
        message: on
          ? `${node.name} is in maintenance — no new servers will be placed on it.`
          : `${node.name} is back in service.`,
      });
      refresh();
    },
    onError,
  });

  if (nodes.error instanceof ApiError && nodes.error.status === 403) {
    return (
      <div className="page-shell">
        <Card>
          <CardBody className="py-10 text-center">
            <p className="text-[13px] text-ink-muted">
              Only the panel owner and administrators can see the machines.
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  const list = nodes.data?.nodes ?? [];

  return (
    <div className="page-shell space-y-5">
      <div className="min-w-0">
        <p className="legend mb-2">Panel</p>
        <h1 className="engraved text-lg sm:text-xl">Machines</h1>
        <p className="mt-1.5 text-[13px] text-ink-muted">
          The hosts your servers run on, and how much of each is already spoken for.
        </p>
      </div>

      {nodes.isLoading ? (
        <Skeleton className="h-56 w-full rounded-lg" />
      ) : (
        <div className="space-y-4">
          {list.map((node) => {
            const memoryTotal = usable(node.capacity.memoryMib, node.capacity.overheadPct);
            const diskTotal = usable(node.capacity.diskMib, node.capacity.overheadPct);

            return (
              <Card key={node.uid}>
                <CardHeader className="flex-row items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle>{node.name}</CardTitle>
                      <Badge tone={node.online ? 'ok' : 'danger'}>
                        {node.online ? 'Reachable' : 'Not responding'}
                      </Badge>
                      {node.maintenance && <Badge tone="warn">Maintenance</Badge>}
                    </div>
                    <CardDescription className="mt-1">
                      {node.transport === 'local' ? 'This machine' : node.transport} ·{' '}
                      {node.servers} server{node.servers === 1 ? '' : 's'}
                      {node.publicHost && ` · players reach it at ${node.publicHost}`}
                    </CardDescription>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Edit"
                    aria-label={`Edit ${node.name}`}
                    onClick={() => setEditing(node)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </CardHeader>

                <CardBody className="space-y-5">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Meter
                      label="Memory promised"
                      icon={MemoryStick}
                      used={node.capacity.allocatedMemoryMib}
                      total={memoryTotal}
                    />
                    <Meter
                      label="Disk promised"
                      icon={HardDrive}
                      used={node.capacity.allocatedDiskMib}
                      total={diskTotal}
                    />
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="inset-well px-3.5 py-2.5">
                      <p className="legend">Ports free</p>
                      <p className="mt-1 font-mono text-[15px] tabular-nums text-ink">
                        {node.freePorts}
                      </p>
                      <p className="mt-0.5 text-[11.5px] text-ink-subtle">
                        out of {node.portRange}
                      </p>
                    </div>
                    <div className="inset-well px-3.5 py-2.5">
                      <p className="legend">Reserved for the host</p>
                      <p className="mt-1 font-mono text-[15px] tabular-nums text-ink">
                        {node.capacity.overheadPct}%
                      </p>
                      <p className="mt-0.5 text-[11.5px] text-ink-subtle">
                        kept back so the machine itself keeps running
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start justify-between gap-4 border-t border-line pt-4">
                    <div>
                      <p className="flex items-center gap-1.5 text-[13px] text-ink">
                        <Wrench className="h-3.5 w-3.5 text-ink-subtle" aria-hidden />
                        Maintenance mode
                      </p>
                      <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-muted">
                        Servers already here keep running. New ones will not be placed on it.
                      </p>
                    </div>
                    <Toggle
                      checked={node.maintenance}
                      onChange={(on) => setMaintenance.mutate({ node, on })}
                      label={`Maintenance mode for ${node.name}`}
                      disabled={setMaintenance.isPending}
                    />
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      <div className="flex items-start gap-2.5 rounded-lg border border-line bg-surface-raised px-4 py-3">
        <Network className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" aria-hidden />
        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          Adding a second machine is not built yet — servers all run on the panel&apos;s own host for
          now. The numbers above are what a remote node would report once it is.
        </p>
      </div>

      {editing && (
        <NodeEditor
          node={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            toast.push({ tone: 'ok', message: 'Machine updated.' });
            setEditing(null);
            refresh();
          }}
          onError={onError}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── editor ──

function NodeEditor({
  node,
  onClose,
  onSaved,
  onError,
}: {
  node: PanelNode;
  onClose: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState(node.name);
  const [publicHost, setPublicHost] = useState(node.publicHost ?? '');
  const [memoryMib, setMemoryMib] = useState(String(node.capacity.memoryMib));
  const [diskMib, setDiskMib] = useState(String(node.capacity.diskMib));
  const [overheadPct, setOverheadPct] = useState(String(node.capacity.overheadPct));

  // CPU cores are settable on the API but not reported by it, so they are not
  // offered here — a field that cannot show its current value is a trap.
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/admin/nodes/${node.uid}`, {
        name: name.trim(),
        publicHost: publicHost.trim() || undefined,
        memoryMib: Number(memoryMib),
        diskMib: Number(diskMib),
        overheadPct: Number(overheadPct),
      }),
    onSuccess: onSaved,
    onError,
  });

  const promisedMemory = node.capacity.allocatedMemoryMib;
  const wouldUnderCut =
    Number(memoryMib) > 0 &&
    usable(Number(memoryMib), Number(overheadPct) || 0) < promisedMemory;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${node.name}`}
      description="What this machine is allowed to hand out."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!name.trim()}
            onClick={() => save.mutate()}
          >
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required help="Only shown here and on the server list.">
          <Input value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        </Field>

        <Field
          label="Address players connect to"
          help="The hostname or IP handed out with every server address on this machine."
        >
          <Input
            value={publicHost}
            onChange={(e) => setPublicHost(e.target.value)}
            placeholder="play.example.com"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Memory (MiB)" help="Total physical memory on the machine.">
            <Input
              type="number"
              min={512}
              value={memoryMib}
              onChange={(e) => setMemoryMib(e.target.value)}
            />
          </Field>

          <Field label="Disk (MiB)" help="Space available for server files and backups.">
            <Input
              type="number"
              min={1024}
              value={diskMib}
              onChange={(e) => setDiskMib(e.target.value)}
            />
          </Field>
        </div>

        <Field
          label="Reserved for the host (%)"
          help="Kept back from the totals above so the operating system, the panel and the database keep working when every server is full."
        >
          <Input
            type="number"
            min={0}
            max={90}
            value={overheadPct}
            onChange={(e) => setOverheadPct(e.target.value)}
          />
        </Field>

        {wouldUnderCut && (
          <div className="rounded-lg border border-warn/30 bg-warn/10 px-4 py-3 text-[12.5px] leading-relaxed text-ink-muted">
            Servers here are already promised {formatMib(promisedMemory)}, which is more than these
            numbers leave available. Nothing running will stop, but the machine will be over its own
            limit until a server is removed or shrunk.
          </div>
        )}
      </div>
    </Modal>
  );
}
