'use client';

export type HardwareLimits = { memoryMib: number; cpuCores: number; diskMib: number };
export type HardwareDraft = { memory: string; cpu: string; disk: string };

export function hardwareDraft(limits: HardwareLimits): HardwareDraft {
  return {
    memory: String(limits.memoryMib / 1024),
    cpu: String(limits.cpuCores),
    disk: String(limits.diskMib / 1024),
  };
}

export function hardwareLimits(draft: HardwareDraft): HardwareLimits {
  return {
    memoryMib: Math.round(Number(draft.memory) * 1024),
    cpuCores: Number(draft.cpu),
    diskMib: Math.round(Number(draft.disk) * 1024),
  };
}

export function HardwareFields({
  value,
  onChange,
}: {
  value: HardwareDraft;
  onChange: (value: HardwareDraft) => void;
}) {
  return (
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
            max: 256,
            hint: 'Fractional cores are supported. 0 removes the CPU cap.',
          },
          {
            key: 'disk',
            label: 'Storage budget (GiB)',
            max: 4096,
            hint: 'Tracked allocation only; disk writes are not capped. 0 means unlimited.',
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
  );
}
