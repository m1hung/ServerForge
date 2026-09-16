'use client';
import type { NodeCapacity, ResourceLimits } from '@serverforge/core';

export type HardwareLimits = ResourceLimits;
export type HardwareDraft = {
  memory: string;
  cpu: string;
  disk: string;
  swap?: string;
  ioWeight?: string;
};

export function hardwareDraft(limits: HardwareLimits): HardwareDraft {
  return {
    memory: String(limits.memoryMib / 1024),
    cpu: String(limits.cpuCores),
    disk: String(limits.diskMib / 1024),
    ...('swapMib' in limits
      ? { swap: limits.swapMib == null ? '' : String(limits.swapMib / 1024) }
      : {}),
    ...('ioWeight' in limits
      ? { ioWeight: limits.ioWeight == null ? '' : String(limits.ioWeight) }
      : {}),
  };
}

export function hardwareLimits(draft: HardwareDraft): HardwareLimits {
  return {
    memoryMib: Math.round(Number(draft.memory) * 1024),
    cpuCores: Number(draft.cpu),
    diskMib: Math.round(Number(draft.disk) * 1024),
    ...(draft.swap !== undefined
      ? { swapMib: draft.swap === '' ? null : Math.round(Number(draft.swap) * 1024) }
      : {}),
    ...(draft.ioWeight !== undefined
      ? { ioWeight: draft.ioWeight === '' ? null : Number(draft.ioWeight) }
      : {}),
  };
}

export function HardwareFields({
  value,
  onChange,
  capacity,
}: {
  value: HardwareDraft;
  onChange: (value: HardwareDraft) => void;
  capacity?: NodeCapacity | null;
}) {
  return (
    <div>
      {capacity && (
        <p className="field-hint">
          {(capacity.memory.availableMib / 1024).toFixed(1)} GiB of memory available for this
          server. Space for the host and your other servers is already reserved.
        </p>
      )}
      <div className="hardware-fields">
        {(
          [
            {
              key: 'memory',
              label: 'Memory (GiB)',
              max: 1024,
              hint: 'Memory for the game. Larger worlds and modpacks may need more. 0 means unlimited.',
            },
            {
              key: 'cpu',
              label: 'CPU cores',
              max: capacity?.cpu.totalCores ?? 256,
              hint: `Processing power. Half cores are allowed${capacity ? `; this host has ${capacity.cpu.totalCores} cores` : ''}. 0 means unlimited.`,
            },
            {
              key: 'disk',
              label: 'Storage budget (GiB)',
              max: 4096,
              hint: 'A space budget for your files, not a hard limit. 0 means no budget.',
            },
          ] as const
        ).map((field) => (
          <div className="configuration-field" key={field.key}>
            <label htmlFor={`hardware-${field.key}`}>{field.label}</label>
            <input
              id={`hardware-${field.key}`}
              name={field.key}
              type="number"
              min={0}
              max={field.max}
              step={field.key === 'cpu' ? 'any' : 1 / 1024}
              required
              value={value[field.key]}
              onChange={(event) => onChange({ ...value, [field.key]: event.target.value })}
              aria-describedby={`hardware-${field.key}-hint`}
            />
            <p id={`hardware-${field.key}-hint`} className="field-hint">
              {field.hint}
            </p>
          </div>
        ))}
      </div>
      {capacity && Number(value.memory) * 1024 > capacity.memory.availableMib && (
        <p className="summary-notice warning" role="status">
          This memory allocation exceeds the remaining budget. Reduce another allocation before
          increasing this one.
        </p>
      )}
      {capacity &&
        capacity.cpu.reservedCores + (Number(value.cpu) || capacity.cpu.totalCores) >
          capacity.cpu.totalCores && (
          <p className="summary-notice warning" role="status">
            CPU will be shared beyond the host’s capacity. Busy servers may slow each other down.
          </p>
        )}
      <details className="settings-details settings-disclosure">
        <summary>Advanced resources</summary>
        <p className="field-hint">
          Optional memory and disk controls. Leave these at the host defaults unless you need to
          tune them.
        </p>
        <div className="settings-field-grid">
          <label>
            Additional swap (GiB)
            <input
              type="number"
              min={0}
              max={1024}
              step={1 / 1024}
              placeholder="Host default"
              value={value.swap ?? ''}
              disabled={capacity?.capabilities.swapLimit === false}
              onChange={(event) => onChange({ ...value, swap: event.target.value })}
            />
            <span className="field-hint">
              {capacity?.capabilities.swapLimit === false
                ? 'Swap control is unavailable on this host; saved limits are not enforced.'
                : 'Zero disables swap. Leave blank to keep the host default. Requires a memory cap.'}
            </span>
          </label>
          <label>
            Storage I/O weight
            <input
              type="number"
              min={10}
              max={1000}
              step={1}
              placeholder="Host default"
              value={value.ioWeight ?? ''}
              disabled={
                capacity?.capabilities.ioWeight === false &&
                !(Number(value.ioWeight) > 0 && Number(value.ioWeight) < 10)
              }
              onChange={(event) => onChange({ ...value, ioWeight: event.target.value })}
            />
            <span className="field-hint">
              {capacity?.capabilities.ioWeight === false
                ? 'Unavailable on this host; saved weights are inactive.'
                : 'Higher values receive more I/O priority during contention; this is not a throughput cap.'}
            </span>
          </label>
        </div>
      </details>
    </div>
  );
}
