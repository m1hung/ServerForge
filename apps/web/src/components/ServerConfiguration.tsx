'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SecurityDialog } from './SecurityDialog';
import type {
  SettingsSchema,
  SettingValues,
  NodeCapacity,
  AppliedAllocation,
} from '@serverforge/core';
import { api } from '@/lib/api';
import { revealField } from '@/lib/forms';
import type { Server } from '@/lib/servers';
import { GameSettingsFields } from './GameSettingsFields';
import {
  HardwareFields,
  hardwareDraft,
  hardwareLimits,
  type HardwareDraft,
} from './HardwareFields';
import { Icon } from './Icon';
import { useUnsavedChanges } from './UnsavedChanges';

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
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const allowed = server.canConfigure !== false;
  const busy = !['running', 'offline', 'crashed', 'install_failed'].includes(server.state);
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [totp, setTotp] = useState(false);
  const canDelete = server.permissions?.includes('server.delete') ?? true;
  const stopped = ['offline', 'crashed', 'install_failed', 'error'].includes(server.state);
  useEffect(() => {
    if (!canDelete) return;
    void api<{ user: { totpEnabledAt: string | null } }>('/api/account')
      .then(({ user }) => setTotp(!!user.totpEnabledAt))
      .catch(() => undefined);
  }, [canDelete]);
  const form = useRef<HTMLFormElement>(null);
  const dirty =
    !!data &&
    !loading &&
    (name !== data.server.name ||
      description !== (data.server.description ?? '') ||
      JSON.stringify(limits) !== JSON.stringify(hardwareDraft(data.server)) ||
      Object.keys({ ...data.values, ...values }).some((key) => values[key] !== data.values[key]));
  function discard() {
    setLoading(true);
    setReload((value) => value + 1);
    setNotice('');
  }
  useUnsavedChanges({
    label: 'Server settings',
    dirty,
    busy: saving || loading,
    scope: `/servers/${server.uid}`,
    save,
    discard,
  });

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
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted) setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [server.uid, allowed, reload]);

  async function save() {
    if (saving || loading || busy || !allowed || !form.current?.checkValidity()) return false;
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
      setNotice(
        result.restartRequired
          ? 'Saved. Restart the server to use your new settings.'
          : 'Saved. Your new settings will apply on the next start.',
      );
      setLoading(true);
      setReload((value) => value + 1);
      await onSaved();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save server settings.');
      return false;
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
    <>
      <form
        ref={form}
        className="card configuration-panel"
        onInvalidCapture={(event) => revealField(event.target as HTMLElement)}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        onChange={(event) => {
          if ((event.target as HTMLInputElement).name !== 'settings-visibility') {
            setNotice('');
          }
        }}
      >
        <div className="section-heading">
          <div>
            <div className="eyebrow">YOUR SERVER, YOUR SETTINGS</div>
            <h2>Server settings</h2>
          </div>
          <Icon name="settings" />
        </div>
        <p className="muted">
          Changes apply on the next start or restart. Saving keeps the current game session running.
        </p>
        {data?.appliedAllocation?.warnings.map((warning) => (
          <p className="summary-notice warning" role="status" key={warning}>
            {warning}
          </p>
        ))}
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
          <p className="muted">{error ? 'Settings unavailable.' : 'Loading settings…'}</p>
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
                  <h3>Resources</h3>
                </div>
                <HardwareFields value={limits} onChange={setLimits} capacity={data.capacity} />
                <details className="settings-details settings-disclosure">
                  <summary>Compare saved and running limits</summary>
                  <div className="table-scroll">
                    <table className="allocation-table">
                      <caption style={{ textAlign: 'left', marginBottom: 8 }}>
                        Saved limits and active limits
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
                          <td style={{ textAlign: 'center' }}>
                            {data.server.memoryMib ? `${data.server.memoryMib} MiB` : 'Unlimited'}
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            {data.appliedAllocation
                              ? data.appliedAllocation.memoryMib
                                ? `${data.appliedAllocation.memoryMib} MiB`
                                : 'Unlimited'
                              : 'Unavailable / offline'}
                          </td>
                        </tr>
                        <tr>
                          <th style={{ textAlign: 'left' }}>CPU</th>
                          <td style={{ textAlign: 'center' }}>
                            {data.server.cpuCores || 'Unlimited'}
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            {data.appliedAllocation
                              ? data.appliedAllocation.cpuCores || 'Unlimited'
                              : '—'}
                          </td>
                        </tr>
                        <tr>
                          <th style={{ textAlign: 'left' }}>Additional swap</th>
                          <td style={{ textAlign: 'center' }}>
                            {data.server.swapMib == null
                              ? 'Docker default'
                              : `${data.server.swapMib} MiB`}
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
                  </div>
                </details>
              </section>
              <section className="form-section">
                <div className="form-section-heading">
                  <h3>Game options</h3>
                </div>
                <GameSettingsFields
                  schema={data.schema}
                  values={values}
                  configuredSecrets={data.configuredSecrets}
                  onChange={(next) => {
                    setValues(next);
                    setNotice('');
                  }}
                />
              </section>
              {canDelete && (
                <section className="form-section">
                  <div className="form-section-heading">
                    <h3>Delete this server</h3>
                  </div>
                  <p className="muted">
                    Permanently removes the server, its world and game files, and every backup made
                    from it. {stopped ? '' : 'Stop the server first.'}
                  </p>
                  <button
                    className="btn danger"
                    type="button"
                    disabled={!stopped || server.busy}
                    onClick={() => setDeleting(true)}
                  >
                    Delete server…
                  </button>
                </section>
              )}
            </fieldset>
            <div className="form-footer">
              <span>
                {dirty
                  ? 'You have unsaved changes.'
                  : 'Changes are saved. Game rules and resources apply on the next start.'}
              </span>
              <div className="row">
                <button
                  className="btn secondary"
                  type="button"
                  disabled={!dirty || saving || loading}
                  onClick={discard}
                >
                  Discard changes
                </button>
                <button
                  className="btn"
                  type="submit"
                  disabled={saving || loading || busy || !dirty}
                >
                  <Icon name="check" size={16} />
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </div>
          </>
        )}
      </form>
      {deleting && (
        <SecurityDialog
          title={`Delete ${server.name}`}
          description="This permanently removes the server, its world and game files, and every backup made from it. Enter your password to confirm."
          requireCode={totp}
          onClose={() => setDeleting(false)}
          onConfirm={async (proof) => {
            await api(`/api/servers/${server.uid}`, {
              method: 'DELETE',
              body: JSON.stringify(proof),
            });
            router.push('/');
          }}
        />
      )}
    </>
  );
}
