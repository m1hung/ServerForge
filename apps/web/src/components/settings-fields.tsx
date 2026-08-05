'use client';

import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { Badge, Field, Input, InfoHint, Select, Textarea, Toggle } from '@/components/ui';
import { cn } from '@/lib/utils';

/**
 * Schema-driven settings rendering.
 *
 * The adapter's SettingsSchema is the only input. Nothing here knows what
 * Minecraft or Palworld is, which is what lets a new game ship without
 * touching the frontend.
 */

export interface Setting {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  label: string;
  help: string;
  tier: 'basic' | 'advanced' | 'expert';
  group: string;
  restartRequired?: boolean;
  showWhen?: { key: string; equals: (string | number | boolean)[] };
  default: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
  multiline?: boolean;
  secret?: boolean;
  options?: { value: string; label: string; help?: string }[];
}

export type Values = Record<string, string | number | boolean>;

export function isVisible(setting: Setting, values: Values): boolean {
  if (!setting.showWhen) return true;
  return setting.showWhen.equals.includes(values[setting.showWhen.key] as string | number | boolean);
}

export function SettingControl({
  setting,
  value,
  error,
  onChange,
}: {
  setting: Setting;
  value: string | number | boolean;
  error?: string;
  onChange: (next: string | number | boolean) => void;
}) {
  const badge = setting.restartRequired ? (
    <Badge tone="warn">Restart required</Badge>
  ) : undefined;

  if (setting.type === 'boolean') {
    // Switches read better inline with their label than stacked under it.
    return (
      <div className="flex items-start justify-between gap-4 py-1">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium text-ink">
              {setting.label}
            </span>
            {badge}
          </div>
          <p className="text-[12.5px] leading-relaxed text-ink-muted">{setting.help}</p>
        </div>
        <Toggle checked={Boolean(value)} onChange={onChange} label={setting.label} />
      </div>
    );
  }

  return (
    <Field label={setting.label} help={setting.help} error={error} badge={badge}>
      {setting.type === 'enum' ? (
        <>
          <Select value={String(value)} onChange={(e) => onChange(e.target.value)}>
            {setting.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          {setting.options?.find((o) => o.value === String(value))?.help && (
            <p className="mt-1.5 text-[12px] text-ink-subtle">
              {setting.options.find((o) => o.value === String(value))?.help}
            </p>
          )}
        </>
      ) : setting.type === 'number' ? (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            value={String(value)}
            min={setting.min}
            max={setting.max}
            step={setting.step ?? 1}
            onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          />
          {setting.unit && (
            <span className="shrink-0 text-[12.5px] text-ink-subtle">{setting.unit}</span>
          )}
        </div>
      ) : setting.multiline ? (
        <Textarea
          value={String(value)}
          maxLength={setting.maxLength}
          placeholder={setting.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          type={setting.secret ? 'password' : 'text'}
          value={String(value)}
          maxLength={setting.maxLength}
          placeholder={setting.placeholder ?? (setting.secret ? 'Leave blank to keep current' : undefined)}
          autoComplete={setting.secret ? 'new-password' : 'off'}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/**
 * Progressive disclosure.
 *
 * Basic settings are always visible. Advanced settings live behind a
 * disclosure that remembers nothing — it reopens closed, because the whole
 * point is that a beginner never sees them by accident.
 */
export function SettingsGroup({
  title,
  settings,
  values,
  errors,
  onChange,
  showAdvanced,
}: {
  title: string;
  settings: Setting[];
  values: Values;
  errors: Record<string, string>;
  onChange: (key: string, value: string | number | boolean) => void;
  showAdvanced: boolean;
}) {
  const visible = settings.filter((s) => isVisible(s, values));
  const basic = visible.filter((s) => s.tier === 'basic');
  const advanced = visible.filter((s) => s.tier !== 'basic');

  if (basic.length === 0 && (!showAdvanced || advanced.length === 0)) return null;

  return (
    <section className="space-y-4">
      <h3 className="eyebrow">{title}</h3>
      <div className="space-y-5">
        {basic.map((setting) => (
          <SettingControl
            key={setting.key}
            setting={setting}
            value={values[setting.key] ?? setting.default}
            error={errors[setting.key]}
            onChange={(next) => onChange(setting.key, next)}
          />
        ))}
        {showAdvanced &&
          advanced.map((setting) => (
            <SettingControl
              key={setting.key}
              setting={setting}
              value={values[setting.key] ?? setting.default}
              error={errors[setting.key]}
              onChange={(next) => onChange(setting.key, next)}
            />
          ))}
      </div>
    </section>
  );
}

export function AdvancedDisclosure({
  open,
  onToggle,
  count,
}: {
  open: boolean;
  onToggle: () => void;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center justify-between rounded-md border border-dashed border-line bg-surface-raised/60 px-4 py-3 text-left transition-colors hover:border-solid hover:border-accent/50"
    >
      <div>
        <p className="text-[13px] font-medium text-ink">Advanced settings</p>
        <p className="mt-0.5 text-[12.5px] text-ink-muted">
          {count} more option{count === 1 ? '' : 's'} — safe defaults are already applied.
        </p>
      </div>
      <ChevronDown
        className={cn('h-4 w-4 shrink-0 text-ink-subtle transition-transform', open && 'rotate-180')}
        aria-hidden
      />
    </button>
  );
}

export { InfoHint };

/** Small helper used by both the wizard and the settings tab. */
export function useDisclosure(initial = false) {
  const [open, setOpen] = useState(initial);
  return { open, toggle: () => setOpen((v) => !v), set: setOpen };
}
