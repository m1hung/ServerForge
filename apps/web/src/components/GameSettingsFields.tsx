'use client';

import { useId, useState } from 'react';
import {
  groupSettings,
  isSettingActive,
  type Setting,
  type SettingsSchema,
  type SettingValues,
} from '@serverforge/core/settings-schema';

export function GameSettingsFields({
  schema,
  values,
  onChange,
  configuredSecrets = [],
}: {
  schema: SettingsSchema;
  values: SettingValues;
  onChange: (values: SettingValues) => void;
  configuredSecrets?: string[];
}) {
  const prefix = useId();
  const [advanced, setAdvanced] = useState(false);
  const extra = schema.some((field) => field.tier !== 'basic');

  function renderField(field: Setting) {
    const id = `${prefix}-${field.key}`;
    const secret = field.type === 'string' && field.secret;
    const retained = configuredSecrets.includes(field.key);
    const value = values[field.key] ?? (secret ? '' : field.default);
    const change = (next: string | number | boolean) => onChange({ ...values, [field.key]: next });
    const shared = { id, name: `setting-${field.key}`, 'aria-describedby': `${id}-hint` };
    return (
      <div className="configuration-field" key={field.key}>
        <label htmlFor={id}>
          {field.label}
          {field.type === 'number' &&
          field.unit &&
          !field.label.toLowerCase().includes(field.unit.toLowerCase())
            ? ` (${field.unit})`
            : ''}
        </label>
        {field.type === 'boolean' ? (
          <div className="setting-checkbox">
            <input
              {...shared}
              type="checkbox"
              checked={value === true}
              onChange={(event) => change(event.target.checked)}
            />
            <span>{value === true ? 'Enabled' : 'Disabled'}</span>
          </div>
        ) : field.type === 'enum' ? (
          <select
            {...shared}
            value={String(value)}
            onChange={(event) => change(event.target.value)}
          >
            {field.options.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : field.type === 'number' ? (
          <input
            {...shared}
            type="number"
            required
            min={field.min}
            max={field.max}
            step={field.step ?? 'any'}
            value={String(value)}
            onChange={(event) =>
              change(event.target.value === '' ? '' : Number(event.target.value))
            }
          />
        ) : field.multiline && !secret ? (
          <textarea
            {...shared}
            rows={3}
            value={String(value)}
            minLength={field.minLength}
            maxLength={field.maxLength}
            required={!!field.minLength}
            placeholder={field.placeholder}
            onChange={(event) => change(event.target.value)}
          />
        ) : (
          <input
            {...shared}
            type={secret ? 'password' : 'text'}
            autoComplete={secret ? 'new-password' : 'off'}
            value={String(value)}
            minLength={field.minLength}
            maxLength={field.maxLength}
            required={!!field.minLength && !retained}
            pattern={field.pattern}
            placeholder={retained ? 'Saved password — leave unchanged to keep' : field.placeholder}
            onChange={(event) => change(event.target.value)}
          />
        )}
        <p className="field-hint" id={`${id}-hint`}>
          {field.help}
        </p>
        {secret && retained && (
          <div className="secret-controls">
            <span className="field-hint">
              {values[field.key] === undefined
                ? 'Saved password will be kept.'
                : values[field.key] === ''
                  ? 'Password will be cleared on save.'
                  : 'Password will be replaced on save.'}
            </span>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                if (values[field.key] === undefined) change('');
                else {
                  const next = { ...values };
                  delete next[field.key];
                  onChange(next);
                }
              }}
            >
              {values[field.key] === undefined ? 'Clear saved password' : 'Keep saved password'}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="game-settings-fields">
      {extra && (
        <label className="advanced-toggle">
          <input
            name="settings-visibility"
            type="checkbox"
            checked={advanced}
            onChange={(event) => setAdvanced(event.target.checked)}
          />
          Show advanced & expert settings
        </label>
      )}
      {groupSettings(
        schema.filter((field) => isSettingActive(field, values)),
        advanced ? ['basic', 'advanced', 'expert'] : ['basic'],
      ).map(({ group, settings }) => (
        <fieldset className="settings-group" key={group}>
          <legend>{group}</legend>
          <div className="settings-field-grid">{settings.map(renderField)}</div>
        </fieldset>
      ))}
    </div>
  );
}
