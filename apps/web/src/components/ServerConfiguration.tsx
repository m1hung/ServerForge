'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type {
  SettingsSchema,
  SettingValues,
  NodeCapacity,
  AppliedAllocation,
} from '@serverforge/core';
import { api } from '@/lib/api';
import type { Server } from '@/lib/servers';
import { GameSettingsFields } from './GameSettingsFields';
import {
  HardwareFields,
  hardwareDraft,
  hardwareLimits,
  type HardwareDraft,
} from './HardwareFields';
import { Icon } from './Icon';

type Configuration = {
  appliedAllocation: AppliedAllocation | null;
  schema: SettingsSchema;
  values: SettingValues;
  configuredSecrets: string[];
  server: Server;
  capacity: NodeCapacity | null;
};

export function ServerConfiguration({
  server,
  onSaved,
}: {
  server: Server;
  onSaved: () => Promise<void>;
}) {
  const [data, setData] = useState<Configuration | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [limits, setLimits] = useState<HardwareDraft>({ memory: '', cpu: '', disk: '' });
  const [values, setValues] = useState<SettingValues>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const allowed = server.canConfigure !== false;
  const busy = !['running', 'offline', 'crashed', 'install_failed'].includes(server.state);

  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<Configuration>(`/api/servers/${server.uid}/settings`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setValues(result.values);
        setName(result.server.name);
        setDescription(result.server.description ?? '');
        setLimits(hardwareDraft(result.server));
        setDirty(false);
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted) setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [server.uid, allowed, reload]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving || loading || busy) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const changed = Object.fromEntries(
        Object.entries(values).filter(([key, value]) => value !== data?.values[key]),
      );
      const result = await api<{ restartRequired: boolean }>(`/api/servers/${server.uid}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          description,
          limits: hardwareLimits(limits),
          settings: changed,
        }),
      });
      setDirty(false);
      setNotice(
        result.restartRequired
          ? 'Saved. Restart the server to apply the new configuration and allocation.'
          : 'Saved. Your configuration and allocation will apply on the next start.',
      );
      setLoading(true);
      setReload((value) => value + 1);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save configuration.');
    } finally {
      setSaving(false);
    }
  }

  if (!allowed)
    return (
      <div className="card">
        <p className="muted">
          You need settings permission to edit this server’s configuration and allocation.
        </p>
      </div>
    );
  return (
    <form
      className="card configuration-panel"
      onSubmit={(event) => void save(event)}
      onChange={(event) => {
        if ((event.target as HTMLInputElement).name !== 'settings-visibility') {
          setDirty(true);
          setNotice('');
        }
      }}
    >
      <div className="section-heading">
        <div>
          <div className="eyebrow">YOUR SERVER, YOUR SETTINGS</div>
          <h2>Configuration & hardware</h2>
        </div>
        <Icon name="settings" />
      </div>
      <p className="muted">
        Changes apply on the next start or restart. Saving keeps the current game session running.
      </p>
      {data && (
        <div className="card" style={{ marginBottom: 16, padding: 14 }}>
          <table style={{ width: '100%', fontSize: 13 }}>
            <caption style={{ textAlign: 'left', marginBottom: 8 }}>
              Saved allocation and running container
            </caption>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Resource</th>
                <th>Saved</th>
                <th>Applied now</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th style={{ textAlign: 'left' }}>Memory</th>
                <td style={{ textAlign: 'center' }}>{data.server.memoryMib || 'Unlimited'} MiB</td>
                <td style={{ textAlign: 'center' }}>
                  {data.appliedAllocation
                    ? `${data.appliedAllocation.memoryMib || 'Unlimited'} MiB`
                    : 'Unavailable / offline'}
                </td>
              </tr>
              <tr>
                <th style={{ textAlign: 'left' }}>CPU</th>
                <td style={{ textAlign: 'center' }}>{data.server.cpuCores || 'Unlimited'}</td>
                <td style={{ textAlign: 'center' }}>
                  {data.appliedAllocation ? data.appliedAllocation.cpuCores || 'Unlimited' : '—'}
                </td>
              </tr>
              <tr>
                <th style={{ textAlign: 'left' }}>Additional swap</th>
                <td style={{ textAlign: 'center' }}>
                  {data.server.swapMib == null ? 'Docker default' : `${data.server.swapMib} MiB`}
                </td>
                <td style={{ textAlign: 'center' }}>
                  {data.appliedAllocation
                    ? data.appliedAllocation.swapMib === -1
                      ? 'Unlimited'
                      : data.appliedAllocation.swapMib == null
                        ? 'Docker default'
                        : `${data.appliedAllocation.swapMib} MiB`
                    : '—'}
                </td>
              </tr>
            </tbody>
          </table>
          {data.appliedAllocation?.warnings.map((warning) => (
            <p className="muted" key={warning} style={{ fontSize: 12 }}>
              {warning}
            </p>
          ))}
        </div>
      )}
      {busy && (
        <p className="summary-notice" role="status">
          Wait for the current server operation to finish before saving.
        </p>
      )}
      {error && (
        <div className="error-banner" role="alert">
          {error}
          {!data && (
            <button className="text-button" type="button" onClick={() => setReload(reload + 1)}>
              Retry
            </button>
          )}
        </div>
      )}
      {notice && (
        <div className="mod-notice" role="status">
          <Icon name="check" size={17} />
          {notice}
        </div>
      )}
      {!data ? (
        <p className="muted">{error ? 'Configuration unavailable.' : 'Loading configuration…'}</p>
      ) : (
        <>
          <fieldset disabled={saving || loading} className="configuration-inputs">
            <section className="form-section">
              <div className="form-section-heading">
                <h3>Server details</h3>
              </div>
              <div className="settings-field-grid">
                <label>
                  Panel name
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    minLength={2}
                    maxLength={48}
                  />
                </label>
                <label>
                  Description
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    maxLength={500}
                    rows={2}
                  />
                </label>
              </div>
            </section>
            <section className="form-section">
              <div className="form-section-heading">
                <h3>Hardware allocation</h3>
              </div>
              <HardwareFields value={limits} onChange={setLimits} capacity={data.capacity} />
            </section>
            <section className="form-section">
              <div className="form-section-heading">
                <h3>Game configuration</h3>
              </div>
              <GameSettingsFields
                schema={data.schema}
                values={values}
                configuredSecrets={data.configuredSecrets}
                onChange={(next) => {
                  setValues(next);
                  setDirty(true);
                  setNotice('');
                }}
              />
            </section>
          </fieldset>
          <div className="form-footer">
            <span>
              {dirty
                ? 'You have unsaved changes.'
                : 'Game version, modpack, and Steam branch are chosen during installation.'}
            </span>
            <div className="row">
              <button
                className="btn secondary"
                type="button"
                disabled={!dirty || saving || loading}
                onClick={() => {
                  setLoading(true);
                  setReload(reload + 1);
                  setNotice('');
                }}
              >
                Discard changes
              </button>
              <button className="btn" type="submit" disabled={saving || loading || busy || !dirty}>
                <Icon name="check" size={16} />
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        </>
      )}
    </form>
  );
}
