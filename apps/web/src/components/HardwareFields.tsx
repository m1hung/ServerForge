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
          {(capacity.memory.availableMib / 1024).toFixed(2)} GiB available to allocate after host
          headroom and other servers · {capacity.cpu.totalCores} CPU cores.
        </p>
      )}
      <div className="hardware-fields">
        {(
          [
            {
              key: 'memory',
              label: 'Memory (GiB)',
              max: 1024,
              hint: 'RAM available to the game server. 0 removes the memory cap.',
            },
            {
              key: 'cpu',
              label: 'CPU cores',
              max: capacity?.cpu.totalCores ?? 256,
              hint: 'Fractional cores are supported. 0 removes the CPU cap.',
            },
            {
              key: 'disk',
              label: 'Storage budget (GiB)',
              max: 4096,
              hint: 'A monitored budget; disk writes are not capped. 0 means no budget.',
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
        <p className="summary-notice" role="status">
          This memory allocation exceeds the remaining budget. Reduce another allocation before
          increasing this one.
        </p>
      )}
      {capacity &&
        capacity.cpu.reservedCores + (Number(value.cpu) || capacity.cpu.totalCores) >
          capacity.cpu.totalCores && (
          <p className="summary-notice" role="status">
            CPU will be shared beyond the host’s capacity. Busy servers may slow each other down.
          </p>
        )}
      <details className="form-section">
        <summary>Advanced resource controls</summary>
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
              Zero disables swap. Leave blank to keep the host default. Requires a memory cap.
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
              disabled={capacity?.capabilities.ioWeight === false && !(Number(value.ioWeight) > 0 && Number(value.ioWeight) < 10)}
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
