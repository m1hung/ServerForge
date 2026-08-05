'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  ExternalLink,
  FileArchive,
  PawPrint,
  Sparkles,
  Upload,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { cn, formatMib } from '@/lib/utils';
import { Badge, Button, Card, CardBody, Field, Input, Select, Textarea, useToast } from '@/components/ui';
import {
  AdvancedDisclosure,
  SettingsGroup,
  isVisible,
  type Setting,
  type Values,
} from '@/components/settings-fields';

/**
 * The deploy wizard.
 *
 * For ordinary editions: Game → Edition → Details → Resources.
 * For modpack editions the Modpack step comes first after Edition, so the
 * pack link or .zip is chosen before the server is created or started.
 */

interface Variant {
  id: string;
  name: string;
  summary: string;
  detail?: string;
  recommended?: boolean;
  tags?: string[];
  supportsMods: boolean;
  defaultLimits: { memoryMib: number; cpuCores: number; diskMib: number };
  requiresEula: boolean;
  eula?: { key: string; label: string; url: string };
}

interface Game {
  id: string;
  name: string;
  summary: string;
  icon: string;
  variants: Variant[];
}

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Box,
  PawPrint,
};

const MODPACK_VARIANTS = new Set(['modrinth-modpack', 'custom-modpack']);

export default function NewServerPage() {
  const router = useRouter();
  const toast = useToast();

  const [step, setStep] = useState(0);
  const [gameId, setGameId] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [version, setVersion] = useState('latest');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [eulaAccepted, setEulaAccepted] = useState(false);
  const [limits, setLimits] = useState({ memoryMib: 4096, cpuCores: 2, diskMib: 10240 });
  const [settings, setSettings] = useState<Values>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [packFile, setPackFile] = useState<File | null>(null);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);

  const games = useQuery({
    queryKey: ['games'],
    queryFn: () => api.get<{ games: Game[] }>('/api/games'),
  });

  const game = games.data?.games.find((g) => g.id === gameId) ?? null;
  const variant = game?.variants.find((v) => v.id === variantId) ?? null;
  const isModpack = Boolean(variantId && MODPACK_VARIANTS.has(variantId));
  const isModrinth = variantId === 'modrinth-modpack';
  const isCustomPack = variantId === 'custom-modpack';

  const stepLabels = useMemo(
    () =>
      isModpack
        ? (['Game', 'Edition', 'Modpack', 'Details', 'Resources'] as const)
        : (['Game', 'Edition', 'Details', 'Resources'] as const),
    [isModpack],
  );
  const lastStep = stepLabels.length - 1;

  /** Map logical phase → index in the current stepLabels list. */
  const phaseIndex = useMemo(() => {
    if (isModpack) {
      return { game: 0, edition: 1, modpack: 2, details: 3, resources: 4 };
    }
    return { game: 0, edition: 1, modpack: -1, details: 2, resources: 3 };
  }, [isModpack]);

  const versions = useQuery({
    queryKey: ['versions', gameId, variantId],
    queryFn: () =>
      api.get<{ versions: { id: string; label: string; stable: boolean }[]; warning?: string }>(
        `/api/games/${gameId}/variants/${variantId}/versions`,
      ),
    enabled: Boolean(gameId && variantId),
  });

  const schema = useQuery({
    queryKey: ['settings-schema', gameId, variantId],
    queryFn: () =>
      api.get<{ schema: Setting[]; defaults: Values }>(
        `/api/games/${gameId}/variants/${variantId}/settings-schema`,
      ),
    enabled: Boolean(gameId && variantId),
  });

  useEffect(() => {
    if (variant) setLimits(variant.defaultLimits);
  }, [variant]);

  useEffect(() => {
    if (schema.data) setSettings(schema.data.defaults);
    setPackFile(null);
    setUploadPercent(null);
  }, [schema.data]);

  // Drop back if the step list shrinks (e.g. leaving a modpack edition).
  useEffect(() => {
    if (step > lastStep) setStep(lastStep);
  }, [lastStep, step]);

  const groups = useMemo(() => {
    if (!schema.data) return [];
    const map: { group: string; settings: Setting[] }[] = [];
    for (const setting of schema.data.schema) {
      let bucket = map.find((g) => g.group === setting.group);
      if (!bucket) {
        bucket = { group: setting.group, settings: [] };
        map.push(bucket);
      }
      bucket.settings.push(setting);
    }
    return map;
  }, [schema.data]);

  const advancedCount = useMemo(
    () =>
      (schema.data?.schema ?? []).filter(
        (s) => s.tier !== 'basic' && s.group !== 'Modpack' && isVisible(s, settings),
      ).length,
    [schema.data, settings],
  );

  const modpackReady = useMemo(() => {
    if (isModrinth) return String(settings.modpack_project ?? '').trim().length > 0;
    if (isCustomPack) {
      return Boolean(packFile) || String(settings.modpack_zip_url ?? '').trim().length > 0;
    }
    return true;
  }, [isModrinth, isCustomPack, settings.modpack_project, settings.modpack_zip_url, packFile]);

  const deploy = useMutation({
    mutationFn: async () => {
      const nextSettings: Values = { ...settings };

      if (isCustomPack && packFile) {
        setUploadPercent(0);
        const staged = await api.upload<{ stagingId: string; filename: string }>(
          '/api/modpack-staging',
          [packFile],
          (percent) => setUploadPercent(percent),
        );
        nextSettings.modpack_staging_id = staged.stagingId;
      }

      return api.post<{ server: { uid: string } }>('/api/servers', {
        name,
        description: description || undefined,
        gameId,
        variantId,
        version: isModpack ? 'from-pack' : version,
        limits,
        settings: nextSettings,
        startOnCreate: true,
      });
    },
    onSuccess: (result) => {
      toast.push({
        tone: 'ok',
        message: 'Setting up your server',
        hint: 'You can watch the progress live — it starts on its own when it is ready.',
      });
      router.push(`/servers/${result.server.uid}`);
    },
    onError: (error) => {
      setUploadPercent(null);
      if (error instanceof ApiError) {
        const fieldErrors: Record<string, string> = {};
        for (const issue of error.fieldIssues) fieldErrors[issue.key] = issue.message;
        setErrors(fieldErrors);
        toast.push({ tone: 'danger', message: error.body.message, hint: error.body.hint });
      }
    },
  });

  const canContinue =
    (step === phaseIndex.game && Boolean(gameId)) ||
    (step === phaseIndex.edition && Boolean(variantId)) ||
    (step === phaseIndex.modpack && modpackReady) ||
    (step === phaseIndex.details &&
      name.trim().length >= 2 &&
      (!variant?.requiresEula || eulaAccepted)) ||
    step === phaseIndex.resources;

  const modpackSummary = isModrinth
    ? String(settings.modpack_project ?? '').trim() || undefined
    : packFile?.name || String(settings.modpack_zip_url ?? '').trim() || undefined;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.back()} aria-label="Go back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <p className="legend mb-2">Provision</p>
          <h1 className="engraved text-lg sm:text-xl">New server</h1>
          <p className="mt-1.5 text-[13px] text-ink-muted">
            {isModpack
              ? 'Pick the modpack first — then name the server and choose resources.'
              : 'Short steps. Everything can be changed later.'}
          </p>
        </div>
      </div>

      <Stepper
        labels={[...stepLabels]}
        current={step}
        onJump={(index) => index < step && setStep(index)}
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_260px]">
        <div className="min-w-0 space-y-4">
          {step === phaseIndex.game && (
            <div className="grid gap-3 sm:grid-cols-2">
              {games.isLoading && <Card className="h-32 animate-pulse" />}
              {games.data?.games.map((entry) => {
                const Icon = ICONS[entry.icon] ?? Box;
                const selected = gameId === entry.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setGameId(entry.id);
                      setVariantId(null);
                      setStep(1);
                    }}
                    className={cn(
                      'card flex items-start gap-4 p-5 text-left transition-colors',
                      selected
                        ? 'border-accent/60 bg-accent/[0.07]'
                        : 'hover:border-line-strong',
                    )}
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-raised">
                      <Icon className="h-5 w-5 text-ink-muted" />
                    </div>
                    <div className="min-w-0">
                      <p className="display text-[14px]">{entry.name}</p>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
                        {entry.summary}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {step === phaseIndex.edition && game && (
            <div className="space-y-3">
              <p className="text-[13px] text-ink-muted">
                Modpack editions ask for the pack next — before anything is created on this machine.
              </p>
              {game.variants.map((entry) => {
                const selected = variantId === entry.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setVariantId(entry.id)}
                    className={cn(
                      'card w-full p-5 text-left transition-colors',
                      selected
                        ? 'border-accent/60 bg-accent/[0.07]'
                        : 'hover:border-line-strong',
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="display text-[13.5px]">{entry.name}</span>
                          {entry.recommended && <Badge tone="accent">Recommended</Badge>}
                          {entry.tags?.map((tag) => (
                            <Badge key={tag}>{tag}</Badge>
                          ))}
                        </div>
                        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">
                          {entry.summary}
                        </p>
                        {selected && entry.detail && (
                          <p className="mt-2.5 animate-fade-in text-[12.5px] leading-relaxed text-ink-subtle">
                            {entry.detail}
                          </p>
                        )}
                      </div>
                      {selected && <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {step === phaseIndex.modpack && variant && (
            <Card>
              <CardBody className="space-y-5">
                <div>
                  <h2 className="display text-[15px]">Choose the modpack</h2>
                  <p className="mt-1 text-[13px] text-ink-muted">
                    Nothing is created on this host until you finish the wizard. The pack is
                    required first.
                  </p>
                </div>

                {isModrinth && (
                  <>
                    <Field
                      label="Modrinth modpack"
                      help='Paste the modpack page link or its short name, e.g. "cobblemon-fabric".'
                      error={errors.modpack_project}
                      required
                    >
                      <Input
                        value={String(settings.modpack_project ?? '')}
                        onChange={(e) =>
                          setSettings((s) => ({ ...s, modpack_project: e.target.value }))
                        }
                        placeholder="https://modrinth.com/modpack/…"
                        maxLength={300}
                        data-autofocus
                      />
                    </Field>
                    <Field
                      label="Pack version"
                      help="Optional. Leave empty for the newest release, or paste a version id from the Modrinth URL."
                    >
                      <Input
                        value={String(settings.modpack_version ?? '')}
                        onChange={(e) =>
                          setSettings((s) => ({ ...s, modpack_version: e.target.value }))
                        }
                        placeholder="latest"
                        maxLength={64}
                      />
                    </Field>
                  </>
                )}

                {isCustomPack && (
                  <>
                    <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-md border border-dashed border-line bg-canvas/40 px-6 py-10 text-center transition-colors hover:border-accent/50 hover:bg-accent/[0.05]">
                      <span className="flex h-10 w-10 items-center justify-center rounded-md border border-line bg-surface-raised text-ink-muted">
                        {packFile ? (
                          <FileArchive className="h-5 w-5 text-accent" aria-hidden />
                        ) : (
                          <Upload className="h-5 w-5" aria-hidden />
                        )}
                      </span>
                      <span>
                        <span className="block text-[13px] font-medium text-ink">
                          {packFile ? packFile.name : 'Drop the server pack .zip here'}
                        </span>
                        <span className="mt-1 block text-[12.5px] text-ink-muted">
                          {packFile
                            ? 'Click to choose a different file'
                            : 'CurseForge “server pack” zips work here'}
                        </span>
                      </span>
                      <input
                        type="file"
                        accept=".zip,.mrpack,application/zip"
                        className="sr-only"
                        onChange={(e) => {
                          const file = e.target.files?.[0] ?? null;
                          setPackFile(file);
                          if (file) setErrors((prev) => ({ ...prev, modpack_zip_url: '' }));
                        }}
                      />
                    </label>

                    <div className="eyebrow relative text-center">
                      <span className="relative z-10 bg-surface px-2">or</span>
                      <span className="absolute inset-x-0 top-1/2 border-t border-line" />
                    </div>

                    <Field
                      label="Download link"
                      help="A direct link to the .zip, if you have one. Upload above is usually easier."
                      error={errors.modpack_zip_url}
                    >
                      <Input
                        value={String(settings.modpack_zip_url ?? '')}
                        onChange={(e) =>
                          setSettings((s) => ({ ...s, modpack_zip_url: e.target.value }))
                        }
                        placeholder="https://…/server-pack.zip"
                        maxLength={2048}
                      />
                    </Field>
                  </>
                )}
              </CardBody>
            </Card>
          )}

          {step === phaseIndex.details && variant && (
            <Card>
              <CardBody className="space-y-5">
                <Field
                  label="Server name"
                  help="Just for you — this is what you will see in the dashboard."
                  error={errors.name}
                  required
                >
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Friday night survival"
                    maxLength={48}
                    data-autofocus
                  />
                </Field>

                <Field label="Description" help="Optional note about what this server is for.">
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={500}
                    rows={2}
                  />
                </Field>

                {!isModpack && (
                  <Field
                    label="Version"
                    help={
                      versions.data?.warning ??
                      'Newest is usually right. Pick an older one if a modpack or your friends need it.'
                    }
                  >
                    <Select value={version} onChange={(e) => setVersion(e.target.value)}>
                      <option value="latest">
                        Latest ({versions.isLoading ? 'loading…' : 'recommended'})
                      </option>
                      {versions.data?.versions.slice(0, 60).map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.label}
                          {entry.stable ? '' : ' — pre-release'}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}

                {groups
                  .filter(
                    (g) =>
                      g.group !== 'Modpack' && g.settings.some((s) => s.tier === 'basic'),
                  )
                  .map((group) => (
                    <SettingsGroup
                      key={group.group}
                      title={group.group}
                      settings={group.settings}
                      values={settings}
                      errors={errors}
                      showAdvanced={false}
                      onChange={(key, value) => setSettings((s) => ({ ...s, [key]: value }))}
                    />
                  ))}

                {variant.requiresEula && variant.eula && (
                  <label className="flex cursor-pointer items-start gap-3 rounded-md border border-line bg-canvas/50 p-3.5">
                    <input
                      type="checkbox"
                      checked={eulaAccepted}
                      onChange={(e) => setEulaAccepted(e.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0 rounded-none accent-[hsl(var(--accent))]"
                    />
                    <span className="text-[12.5px] leading-relaxed text-ink-muted">
                      {variant.eula.label}.{' '}
                      <a
                        href={variant.eula.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-accent underline underline-offset-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Read it
                        <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                      . This is required by the game publisher, not by us.
                    </span>
                  </label>
                )}
              </CardBody>
            </Card>
          )}

          {step === phaseIndex.resources && (
            <div className="space-y-4">
              <Card>
                <CardBody className="space-y-5">
                  <Field
                    label="Memory"
                    help="The single most important setting. Too little and the server crashes under load; too much and you waste what other servers could use."
                    error={errors.memoryMib}
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={1024}
                        max={32768}
                        step={512}
                        value={limits.memoryMib}
                        onChange={(e) => setLimits({ ...limits, memoryMib: Number(e.target.value) })}
                        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-sm bg-line accent-[hsl(var(--accent))]"
                        aria-label="Memory in megabytes"
                      />
                      <span className="w-20 shrink-0 text-right font-mono text-[13px] text-ink">
                        {formatMib(limits.memoryMib)}
                      </span>
                    </div>
                    {variant && limits.memoryMib < variant.defaultLimits.memoryMib && (
                      <p className="mt-2 text-[12.5px] text-warn">
                        Below the {formatMib(variant.defaultLimits.memoryMib)} we recommend for{' '}
                        {variant.name}. It may run, but expect stutters with several players.
                      </p>
                    )}
                  </Field>

                  <Field
                    label="CPU cores"
                    help="Most game servers use one core heavily and a second for background work. More than four rarely helps."
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={1}
                        max={16}
                        step={0.5}
                        value={limits.cpuCores}
                        onChange={(e) => setLimits({ ...limits, cpuCores: Number(e.target.value) })}
                        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-sm bg-line accent-[hsl(var(--accent))]"
                        aria-label="CPU cores"
                      />
                      <span className="w-20 shrink-0 text-right font-mono text-[13px] text-ink">
                        {limits.cpuCores}
                      </span>
                    </div>
                  </Field>

                  <Field
                    label="Disk"
                    help="Worlds grow as players explore. Modpacks start large. We stop the server before it can fill the machine's disk."
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={2048}
                        max={204800}
                        step={1024}
                        value={limits.diskMib}
                        onChange={(e) => setLimits({ ...limits, diskMib: Number(e.target.value) })}
                        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-sm bg-line accent-[hsl(var(--accent))]"
                        aria-label="Disk in megabytes"
                      />
                      <span className="w-20 shrink-0 text-right font-mono text-[13px] text-ink">
                        {formatMib(limits.diskMib)}
                      </span>
                    </div>
                  </Field>
                </CardBody>
              </Card>

              {advancedCount > 0 && (
                <>
                  <AdvancedDisclosure
                    open={showAdvanced}
                    onToggle={() => setShowAdvanced((v) => !v)}
                    count={advancedCount}
                  />
                  {showAdvanced && (
                    <Card>
                      <CardBody className="space-y-7">
                        {groups
                          .filter((g) => g.group !== 'Modpack')
                          .map((group) => (
                            <SettingsGroup
                              key={group.group}
                              title={group.group}
                              settings={group.settings.filter((s) => s.tier !== 'basic')}
                              values={settings}
                              errors={errors}
                              showAdvanced
                              onChange={(key, value) =>
                                setSettings((s) => ({ ...s, [key]: value }))
                              }
                            />
                          ))}
                      </CardBody>
                    </Card>
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 pt-2">
            <Button
              variant="ghost"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={step === 0}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back
            </Button>

            {step < lastStep ? (
              <Button
                variant="primary"
                disabled={!canContinue}
                onClick={() => setStep((s) => Math.min(lastStep, s + 1))}
              >
                Continue
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
            ) : (
              <Button
                variant="primary"
                size="lg"
                loading={deploy.isPending}
                loadingText={
                  uploadPercent != null
                    ? `Uploading pack… ${Math.round(uploadPercent)}%`
                    : 'Creating…'
                }
                disabled={!canContinue}
                onClick={() => deploy.mutate()}
              >
                <Sparkles className="h-4 w-4" aria-hidden />
                Create server
              </Button>
            )}
          </div>
        </div>

        <aside className="hidden lg:block">
          <Card className="sticky top-20">
            <CardBody className="space-y-2.5 text-[12.5px]">
              <p className="eyebrow">Summary</p>
              <SummaryRow label="Game" value={game?.name} />
              <SummaryRow label="Edition" value={variant?.name} />
              {isModpack && <SummaryRow label="Modpack" value={modpackSummary} />}
              {!isModpack && (
                <SummaryRow label="Version" value={version === 'latest' ? 'Latest' : version} />
              )}
              <SummaryRow label="Name" value={name || undefined} />
              <SummaryRow label="Memory" value={formatMib(limits.memoryMib)} />
              <SummaryRow label="CPU" value={`${limits.cpuCores} cores`} />
              <SummaryRow label="Disk" value={formatMib(limits.diskMib)} />
            </CardBody>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 text-ink-subtle">{label}</span>
      <span
        className={cn(
          'min-w-0 truncate text-right font-mono text-[12px]',
          value ? 'text-ink' : 'text-ink-subtle',
        )}
      >
        {value ?? 'not set'}
      </span>
    </div>
  );
}

function Stepper({
  labels,
  current,
  onJump,
}: {
  labels: string[];
  current: number;
  onJump: (index: number) => void;
}) {
  return (
    <ol className="flex items-center gap-2" aria-label="Progress">
      {labels.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <button
              type="button"
              onClick={() => onJump(index)}
              disabled={!done}
              aria-current={active ? 'step' : undefined}
              className={cn(
                // The bottom rule is the progress track: solid where you are,
                // green behind you, hairline ahead.
                'flex w-full items-center gap-2 rounded-t-md border-b-2 px-2.5 py-2 text-left text-[12.5px] transition-colors',
                active && 'border-b-accent font-medium text-ink',
                done && 'cursor-pointer border-b-ok/50 text-ink-muted hover:bg-surface-raised hover:text-ink',
                !active && !done && 'border-b-line text-ink-subtle',
              )}
            >
              <span
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
                  active ? 'bg-accent text-accent-ink' : done ? 'bg-ok/20 text-ok' : 'bg-surface-raised',
                )}
              >
                {done ? <Check className="h-3 w-3" aria-hidden /> : index + 1}
              </span>
              <span className="hidden truncate sm:inline">{label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
