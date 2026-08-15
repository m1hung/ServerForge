'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, Card, CardBody, Skeleton, useToast } from '@/components/ui';
import {
  AdvancedDisclosure,
  SettingsGroup,
  isVisible,
  type Setting,
  type Values,
} from '@/components/settings-fields';
import type { ServerState } from '@/components/server-status';

/**
 * The settings tab.
 *
 * Dirty tracking is per-key so a save sends only what changed — which matters
 * because sending every value back would overwrite a secret the API
 * deliberately redacted on read.
 */
export function SettingsPanel({ uid, state }: { uid: string; state: ServerState }) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [values, setValues] = useState<Values>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);

  const settings = useQuery({
    queryKey: ['settings', uid],
    queryFn: () =>
      api.get<{ schema: Setting[]; values: Values; groups: { group: string; settings: Setting[] }[] }>(
        `/api/servers/${uid}/settings`,
      ),
  });

  useEffect(() => {
    if (settings.data) {
      setValues(settings.data.values);
      setDirty(new Set());
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () => {
      const patch: Values = {};
      for (const key of dirty) {
        const value = values[key];
        if (value !== undefined) patch[key] = value;
      }
      return api.patch<{ needsRestart: boolean; message: string }>(`/api/servers/${uid}/settings`, {
        values: patch,
      });
    },
    onSuccess: (result) => {
      setDirty(new Set());
      setErrors({});
      toast.push({
        tone: 'ok',
        message: result.message,
        hint: result.needsRestart ? 'Some changes need a restart to take effect.' : undefined,
      });
      queryClient.invalidateQueries({ queryKey: ['settings', uid] });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        const next: Record<string, string> = {};
        for (const issue of error.fieldIssues) next[issue.key] = issue.message;
        setErrors(next);
        toast.push({ tone: 'danger', message: error.body.message });
      }
    },
  });

  const advancedCount = useMemo(
    () => (settings.data?.schema ?? []).filter((s) => s.tier !== 'basic' && isVisible(s, values)).length,
    [settings.data, values],
  );

  if (settings.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const onChange = (key: string, value: string | number | boolean) => {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty((current) => new Set(current).add(key));
  };

  const hasChanges = dirty.size > 0;

  return (
    <div className="space-y-4 pb-sticky-actions">
      <Card>
        <CardBody className="space-y-8">
          {settings.data?.groups.map((group) => (
            <SettingsGroup
              key={group.group}
              title={group.group}
              settings={group.settings}
              values={values}
              errors={errors}
              showAdvanced={showAdvanced}
              onChange={onChange}
            />
          ))}
        </CardBody>
      </Card>

      {advancedCount > 0 && (
        <AdvancedDisclosure
          open={showAdvanced}
          onToggle={() => setShowAdvanced((v) => !v)}
          count={advancedCount}
        />
      )}

      {/* A sticky bar rather than a button at the bottom of a long form: on a
          settings page nobody scrolls back up to find Save. */}
      {hasChanges && (
        <div className="sticky-action-bar">
          <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <p className="text-[13px] text-ink-muted">
              {dirty.size} unsaved change{dirty.size === 1 ? '' : 's'}
              {['running', 'starting'].includes(state) && ' — a restart may be needed'}
            </p>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                className="flex-1 sm:flex-none"
                onClick={() => {
                  if (settings.data) setValues(settings.data.values);
                  setDirty(new Set());
                  setErrors({});
                }}
              >
                Discard
              </Button>
              <Button
                variant="primary"
                className="flex-1 sm:flex-none"
                loading={save.isPending}
                loadingText="Saving…"
                onClick={() => save.mutate()}
              >
                <Save className="h-4 w-4" aria-hidden />
                Save changes
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
