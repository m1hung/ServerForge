'use client';

import { FormEvent, useEffect, useState } from 'react';
import type { SettingsSchema, SettingValues, NodeCapacity } from '@serverforge/core';
import { GameSettingsFields } from '@/components/GameSettingsFields';
import {
  HardwareFields,
  hardwareDraft,
  hardwareLimits,
  type HardwareDraft,
} from '@/components/HardwareFields';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/Icon';
import { PageTitle } from '@/components/PageTitle';
import { api } from '@/lib/api';
import { memoryLabel } from '@/lib/servers';

type Game = { id: string; name: string; summary: string };
type Compatibility = { platform: 'linux/amd64' | 'linux/arm64'; status: 'supported' | 'experimental' | 'unsupported'; reason: string };
type Variant = {
  id: string;
  name: string;
  recommended?: boolean;
  supportsMods: boolean;
  detail?: string;
  summary: string;
  schema: SettingsSchema;
  settings: SettingValues;
  eula: { key: string; label: string; url: string } | null;
  defaults: { memoryMib: number; cpuCores: number; diskMib: number };
};

export default function DeployPage() {
  const router = useRouter();
  const [games, setGames] = useState<Game[] | null>(null);
  const [gameId, setGameId] = useState('');
  const [variants, setVariants] = useState<Variant[]>([]);
  const [variantId, setVariantId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState(0);
  const [version, setVersion] = useState('latest');
  const [settings, setSettings] = useState<SettingValues>({});
  const [limits, setLimits] = useState<HardwareDraft>({ memory: '', cpu: '', disk: '' });
  const [packSource, setPackSource] = useState('upload');
  const [packFile, setPackFile] = useState<File | null>(null);
  const [capacity, setCapacity] = useState<NodeCapacity | null>(null);
  const [compatibility, setCompatibility] = useState<Compatibility | null>(null);
  const [allowExperimental, setAllowExperimental] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api<{ nodes: { capacity: NodeCapacity | null; transport: string }[] }>('/api/nodes', {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted)
          setCapacity(result.nodes.find((node) => node.transport === 'docker')?.capacity ?? null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setCapacity(null);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api<{ games: Game[] }>('/api/games', { signal: controller.signal })
      .then((data) => {
        setGames(data.games);
        setGameId((current) => current || data.games[0]?.id || '');
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    if (!gameId) return;
    const controller = new AbortController();
    setVariants([]);
    setCompatibility(null); setAllowExperimental(false);
    setVariantId('');
    setError('');
    api<{ variants: Variant[]; compatibility: Compatibility }>(`/api/games/${gameId}`, { signal: controller.signal })
      .then((data) => {
        setVariants(data.variants);
        setCompatibility(data.compatibility);
        setVariantId(
          data.variants.find((item) => item.recommended)?.id ?? data.variants[0]?.id ?? '',
        );
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [gameId, retry]);

  const game = games?.find((item) => item.id === gameId);
  const variant = variants.find((item) => item.id === variantId);
  const isPack = variantId === 'modrinth-modpack' || variantId === 'custom-modpack';

  useEffect(() => {
    setVersion('latest');
    setSettings(variant?.settings ?? {});
    setPackSource('upload');
    setPackFile(null);
    setLimits(variant ? hardwareDraft(variant.defaults) : { memory: '', cpu: '', disk: '' });
  }, [variant]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!variant || pending) return;
    const form = new FormData(event.currentTarget);
    const packSettings =
      variantId === 'modrinth-modpack'
        ? {
            modpack_project: String(form.get('modpack_project') ?? '').trim(),
            modpack_version: String(form.get('modpack_version') ?? '').trim(),
          }
        : variantId === 'custom-modpack'
          ? {
              modpack_zip_url:
                packSource === 'url' ? String(form.get('modpack_zip_url') ?? '').trim() : '',
            }
          : {};
    setError('');
    setPending(true);
    try {
      const configuration = JSON.stringify({
        runtimePlatform: compatibility?.platform,
        allowExperimental,
        name: name.trim(),
        gameId,
        variantId,
        version: isPack ? 'latest' : version.trim() || 'latest',
        limits: hardwareLimits(limits),
        settings: { ...settings, ...packSettings },
        acceptedEula: variant.eula && form.get('eula') === 'on' ? variant.eula.key : undefined,
        startOnCreate: false,
      });
      let body: string | FormData = configuration;
      if (variantId === 'custom-modpack' && packSource === 'upload') {
        if (!packFile) throw new Error('Choose a server pack ZIP to upload.');
        body = new FormData();
        body.append('configuration', configuration);
        body.append('pack', packFile);
      }
      const created = await api<{ server: { uid: string } }>('/api/servers', {
        method: 'POST',
        body,
      });
      router.push(`/servers/${created.server.uid}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not deploy.');
      setPending(false);
    }
  }

  return (
    <>
      <Link className="back-link" href="/">
        <Icon name="arrow" size={15} />
        Back to overview
      </Link>
      <div className="page-heading">
        <div>
          <div className="eyebrow">A NEW ADVENTURE AWAITS</div>
          <PageTitle>Deploy a server</PageTitle>
          <p className="muted">Pick your game. Make it yours. Bring everyone together.</p>
        </div>
      </div>
      <div className="deploy-layout">
        <form className="card" onSubmit={(event) => void onSubmit(event)} aria-busy={pending}>
          <section className="form-section">
            <div className="form-section-heading">
              <span className="step-number">1</span>
              <h2>Choose your game</h2>
            </div>
            {!games && !error && (
              <p className="muted" role="status">
                Loading available games…
              </p>
            )}
            {games?.length === 0 && (
              <p className="muted">No games are available on this installation yet.</p>
            )}
            <div className="game-picker" role="group" aria-label="Choose your game">
              {games?.map((item) => (
                <button
                  type="button"
                  className={`game-choice ${gameId === item.id ? 'selected' : ''}`}
                  key={item.id}
                  aria-pressed={gameId === item.id}
                  disabled={pending}
                  onClick={() => {
                    if (item.id === gameId) return;
                    setVariants([]);
                    setVariantId('');
                    setGameId(item.id);
                  }}
                >
                  <span className={`game-icon game-${item.id}`}>
                    <Icon name="cube" size={20} />
                  </span>
                  <strong>{item.name}</strong>
                  {gameId === item.id && <Icon name="check" size={16} />}
                </button>
              ))}
            </div>
            {game && <p className="field-hint">{game.summary}</p>}
          </section>
          <section className="form-section">
            <div className="form-section-heading">
              <span className="step-number">2</span>
              <h2>Make it yours</h2>
            </div>
            <div className="stack">
              <label>
                Game edition
                <select
                  value={variantId}
                  disabled={!variants.length || pending}
                  onChange={(event) => setVariantId(event.target.value)}
                  required
                >
                  {!variants.length && (
                    <option value="">{gameId ? 'Loading editions…' : 'Select a game first'}</option>
                  )}
                  {variants.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.recommended ? ' · Recommended' : ''}
                      {item.supportsMods ? ' · Mods' : ''}
                    </option>
                  ))}
                </select>
              </label>
              {variant && (
                <div className="edition-info" key={variant.id}>
                  <span className={`status-pill ${variant.supportsMods ? 'success' : 'neutral'}`}>
                    <Icon name={variant.supportsMods ? 'cube' : 'shield'} size={14} />
                    {variant.supportsMods ? 'Mods supported' : 'Vanilla experience'}
                  </span>
                  <p>{variant.detail || variant.summary}</p>
                  {variantId === 'modrinth-modpack' && (
                    <div className="stack">
                      <label>
                        Modrinth modpack
                        <input
                          name="modpack_project"
                          required
                          maxLength={300}
                          disabled={pending}
                          placeholder="Modpack link, slug, or project ID"
                        />
                      </label>
                      <label>
                        Pack version <span className="field-hint">(optional)</span>
                        <input
                          name="modpack_version"
                          maxLength={64}
                          disabled={pending}
                          placeholder="Latest release, or a specific version ID"
                        />
                      </label>
                      <p className="field-hint">
                        The pack determines the Minecraft version, loader, and dependencies.
                      </p>
                    </div>
                  )}
                  {variantId === 'custom-modpack' && (
                    <div className="stack">
                      <label>
                        Server pack source
                        <select
                          value={packSource}
                          disabled={pending}
                          onChange={(event) => {
                            setPackSource(event.target.value);
                            setPackFile(null);
                            setError('');
                          }}
                        >
                          <option value="upload">Upload a ZIP file</option>
                          <option value="url">Use a download link</option>
                        </select>
                      </label>
                      {packSource === 'upload' ? (
                        <div className="configuration-field">
                          <label htmlFor="server-pack-file">CurseForge server pack ZIP</label>
                          <input
                            id="server-pack-file"
                            name="pack"
                            type="file"
                            accept=".zip,application/zip,application/x-zip-compressed"
                            required
                            disabled={pending}
                            aria-describedby="server-pack-hint"
                            onChange={(event) => {
                              const file = event.target.files?.[0] ?? null;
                              if (
                                file &&
                                (!/\.zip$/i.test(file.name) ||
                                  !file.size ||
                                  file.size > 2 * 1024 ** 3)
                              ) {
                                setError('Choose a non-empty server pack ZIP, up to 2 GiB.');
                                event.target.value = '';
                                setPackFile(null);
                              } else {
                                setPackFile(file);
                                setError('');
                              }
                            }}
                          />
                          <p className="field-hint" id="server-pack-hint">
                            Choose the Server Pack download from CurseForge, up to 2 GiB.
                            Client/profile export ZIPs are not supported.
                          </p>
                          {packFile && (
                            <p className="field-hint" role="status">
                              {packFile.name} · {(packFile.size / 1024 ** 2).toFixed(1)} MiB · Ready
                              to upload
                            </p>
                          )}
                        </div>
                      ) : (
                        <label>
                          Server-pack ZIP URL
                          <input
                            name="modpack_zip_url"
                            type="url"
                            pattern="https://.*"
                            required
                            maxLength={2048}
                            disabled={pending}
                            placeholder="https://example.com/server-pack.zip"
                          />
                          <span className="field-hint">
                            A public HTTPS download of a server pack, up to 2 GiB. Client-only packs
                            do not include the server files.
                          </span>
                        </label>
                      )}
                    </div>
                  )}
                </div>
              )}
              {gameId === 'minecraft-java' && !isPack && (
                <label>
                  Minecraft version
                  <input
                    value={version}
                    onChange={(event) => setVersion(event.target.value)}
                    required
                    maxLength={64}
                    disabled={pending}
                    placeholder="latest or 1.20.1"
                  />
                  <span className="field-hint">
                    Use “latest” or the exact version required by your mods. Match the loader and
                    game version on every mod.
                  </span>
                </label>
              )}
              <label>
                Panel name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  minLength={2}
                  maxLength={48}
                  disabled={pending}
                  placeholder="e.g. The weekend crew"
                  autoComplete="off"
                />
                <span className="field-hint">Give your community a place to call home.</span>
              </label>
              {variant?.eula && (
                <label className="checkbox-label" key={`eula-${gameId}-${variantId}`}>
                  <input type="checkbox" name="eula" required disabled={pending} />
                  <span>
                    I accept the{' '}
                    <a href={variant.eula.url} target="_blank" rel="noreferrer">
                      {game?.name} EULA
                    </a>
                    .
                  </span>
                </label>
              )}
            </div>
          </section>
          {variant && (
            <fieldset className="configuration-inputs deploy-configuration" disabled={pending}>
              <section className="form-section">
                <div className="form-section-heading">
                  <span className="step-number">3</span>
                  <h2>Allocate hardware</h2>
                </div>
                <HardwareFields value={limits} onChange={setLimits} capacity={capacity} />
                {compatibility && <div className="stack" style={{ marginTop: 12 }}><p className="muted">{compatibility.platform} · {compatibility.status}. {compatibility.reason}</p>{compatibility.status === 'experimental' && <label className="row"><input type="checkbox" checked={allowExperimental} onChange={(event) => setAllowExperimental(event.target.checked)} />I understand this game/platform combination is experimental.</label>}</div>}
                <button
                  className="text-button reset-hardware"
                  type="button"
                  onClick={() => setLimits(hardwareDraft(variant.defaults))}
                >
                  Use recommended allocation
                </button>
              </section>
              <section className="form-section">
                <div className="form-section-heading">
                  <span className="step-number">4</span>
                  <h2>Configure your game</h2>
                </div>
                <GameSettingsFields
                  key={variantId}
                  schema={variant.schema.filter((field) => field.group !== 'Modpack')}
                  values={settings}
                  onChange={setSettings}
                />
              </section>
            </fieldset>
          )}
          {error && (
            <div className="error-banner" role="alert" style={{ marginTop: 20 }}>
              <Icon name="alert" size={17} />
              <div>{error}</div>
              {!variant && (
                <button type="button" className="text-button" onClick={() => setRetry(retry + 1)}>
                  Retry
                </button>
              )}
            </div>
          )}
          <div className="form-footer">
            <span role={pending ? 'status' : undefined}>
              {pending && variantId === 'custom-modpack' && packSource === 'upload'
                ? 'Uploading your ZIP. Keep this page open until the server is created.'
                : 'Installs first. Start it when you’re ready.'}
            </span>
            <button
              className="btn"
              type="submit"
              disabled={!variant || !compatibility || compatibility.status === 'unsupported' || (compatibility.status === 'experimental' && !allowExperimental) || name.trim().length < 2 || pending}
            >
              <Icon
                name={pending ? 'refresh' : 'plus'}
                size={17}
                className={pending ? 'spin' : ''}
              />
              {pending
                ? variantId === 'custom-modpack' && packSource === 'upload'
                  ? 'Uploading & creating…'
                  : 'Creating server…'
                : 'Create server'}
            </button>
          </div>
        </form>
        <aside className="deploy-summary">
          <span className={`game-icon game-${gameId}`}>
            <Icon name="cube" size={23} />
          </span>
          <div className="eyebrow">YOUR DEPLOYMENT</div>
          <h2>{name.trim() || 'Your new server'}</h2>
          <p className="muted">
            {game?.name || 'Choose a game'}
            {variant ? ` · ${variant.name}` : ''}
          </p>
          <dl className="summary-list">
            <div>
              <dt>Version</dt>
              <dd>
                {isPack
                  ? 'From modpack'
                  : version === 'latest'
                    ? 'Latest available'
                    : version || '—'}
              </dd>
            </div>
            <div>
              <dt>Memory limit</dt>
              <dd>{variant ? memoryLabel(hardwareLimits(limits).memoryMib) : '—'}</dd>
            </div>
            <div>
              <dt>CPU limit</dt>
              <dd>
                {variant
                  ? hardwareLimits(limits).cpuCores
                    ? `${hardwareLimits(limits).cpuCores} cores`
                    : 'Unlimited'
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Storage budget</dt>
              <dd>{variant ? memoryLabel(hardwareLimits(limits).diskMib) : '—'}</dd>
            </div>
          </dl>
          <div className="summary-notice">
            <Icon name="shield" size={16} />
            Starts with recommended hardware. Adjust the allocation and game settings to fit your
            crew.
          </div>
        </aside>
      </div>
    </>
  );
}
