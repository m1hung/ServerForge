'use client';

import { useId, useState } from 'react';
import { revealField } from '@/lib/forms';
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
  const [search, setSearch] = useState('');
  const active = schema.filter((field) => isSettingActive(field, values));
  const query = search.trim().toLowerCase();
  const matches = schema.filter((field) =>
    [field.label, field.help, field.group, field.key].some((text) =>
      text.toLowerCase().includes(query),
    ),
  );

  function renderField(field: Setting) {
    const id = `${prefix}-${field.key}`;
    const secret = field.type === 'string' && field.secret;
    const retained = configuredSecrets.includes(field.key);
    const value = values[field.key] ?? (secret ? '' : field.default);
    const change = (next: string | number | boolean) => onChange({ ...values, [field.key]: next });
    const shared = { id, name: `setting-${field.key}`, 'aria-describedby': `${id}-hint` };
    return (
      <div className="configuration-field" key={field.key}>
        {field.type !== 'boolean' && (
          <label htmlFor={id}>
            {field.label}
            {field.type === 'number' &&
            field.unit &&
            !field.label.toLowerCase().includes(field.unit.toLowerCase())
              ? ` (${field.unit})`
              : ''}
          </label>
        )}
        {field.type === 'boolean' ? (
          <label className="setting-checkbox" htmlFor={id}>
            <input
              {...shared}
              type="checkbox"
              checked={value === true}
              onChange={(event) => change(event.target.checked)}
            />
            {field.label}
          </label>
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

  const groups = (fields: SettingsSchema) =>
    groupSettings(fields, ['basic', 'advanced', 'expert']).map(({ group, settings }) => (
      <fieldset className="settings-group" key={group}>
        <legend>{group}</legend>
        <div className="settings-field-grid">{settings.map(renderField)}</div>
      </fieldset>
    ));

  return (
    <div className="game-settings-fields">
      <div className="settings-search">
        <label htmlFor={`${prefix}-search`}>Find a game setting</label>
        <div className="row">
          <input
            id={`${prefix}-search`}
            type="search"
            name="settings-visibility"
            placeholder="Search all settings, including advanced options"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
          {search && (
            <button
              type="button"
              className="btn secondary small"
              onClick={() => {
                setSearch('');
                document.getElementById(`${prefix}-search`)?.focus();
              }}
            >
              Clear search
            </button>
          )}
        </div>
        {query && (
          <>
            <p className="field-hint" role="status">
              {matches.length
                ? `${matches.length} matching ${matches.length === 1 ? 'setting' : 'settings'}. Select one to edit it.`
                : 'No matching settings. Try another name or clear your search.'}
            </p>
            {!!matches.length && (
              <ul className="settings-search-results">
                {matches.map((field) => {
                  const dependency = !isSettingActive(field, values)
                    ? schema.find((parent) => parent.key === field.showWhen?.key)
                    : undefined;
                  const requiredValues = field.showWhen?.equals
                    .map((value) =>
                      dependency?.type === 'enum'
                        ? (dependency.options.find((option) => option.value === value)?.label ??
                          String(value))
                        : typeof value === 'boolean'
                          ? value
                            ? 'On'
                            : 'Off'
                          : String(value),
                    )
                    .join(' or ');
                  return (
                    <li key={field.key}>
                      <button
                        type="button"
                        onClick={() => {
                          const input = document.getElementById(
                            `${prefix}-${dependency?.key ?? field.key}`,
                          );
                          if (input) {
                            revealField(input);
                            input.focus({ preventScroll: true });
                            input.scrollIntoView({ block: 'center' });
                          }
                        }}
                      >
                        <span>{field.label}</span>
                        <span className="field-hint">
                          {dependency
                            ? `Set ${dependency.label} to ${requiredValues} first`
                            : `${field.group}${field.tier !== 'basic' ? ` · ${field.tier}` : ''}`}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
      {groups(active.filter((field) => field.tier === 'basic'))}
      {(['advanced', 'expert'] as const).map((tier) => {
        const fields = active.filter((field) => field.tier === tier);
        return (
          !!fields.length && (
            <details className="settings-details settings-disclosure" key={tier}>
              <summary>
                {tier === 'advanced' ? 'Advanced game settings' : 'Expert game settings'}{' '}
                <span className="field-hint">({fields.length})</span>
              </summary>
              <p className="field-hint">
                {tier === 'advanced'
                  ? 'Fine-tune your world, player access and performance when you need to.'
                  : 'Specialized controls for experienced administrators. Review each description before changing a value.'}
              </p>
              {groups(fields)}
            </details>
          )
        );
      })}
    </div>
  );
}
