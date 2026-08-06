'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Skeleton,
  useToast,
} from '@/components/ui';

/**
 * Panel settings.
 *
 * Owner/admin only, and deliberately separate from Account: everything here
 * changes the panel for everyone, not the person looking at it.
 *
 * Credentials on this page are write-only. A stored key is never sent back to
 * the browser — the panel reports only whether one exists and where it came
 * from, so an admin can tell "nothing is set" apart from "something is set
 * that I cannot see".
 */

interface PanelSettings {
  settings: Record<string, unknown>;
  integrations: {
    curseforge: {
      configured: boolean;
      source: 'panel' | 'environment' | null;
    };
  };
}

export default function PanelSettingsPage() {
  const settings = useQuery({
    queryKey: ['panel-settings'],
    queryFn: () => api.get<PanelSettings>('/api/admin/settings'),
    retry: false,
  });

  if (settings.error instanceof ApiError && settings.error.status === 403) {
    return (
      <div className="page-shell">
        <Card>
          <CardBody className="py-10 text-center">
            <p className="text-[13px] text-ink-muted">
              Only the panel owner and administrators can change panel settings.
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="page-shell space-y-4">
      {settings.isLoading ? (
        <Card>
          <CardBody className="space-y-3 py-6">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-9 w-full" />
          </CardBody>
        </Card>
      ) : (
        <CurseForgeCard
          state={settings.data?.integrations.curseforge ?? { configured: false, source: null }}
        />
      )}
    </div>
  );
}

/**
 * The CurseForge key.
 *
 * CurseForge's terms require each host to use their own key, so the panel
 * cannot ship one and this is the only way to turn browsing on. Everything
 * else about mods works without it.
 */
function CurseForgeCard({
  state,
}: {
  state: { configured: boolean; source: 'panel' | 'environment' | null };
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState('');

  const save = useMutation({
    mutationFn: (value: string) =>
      api.put<{ configured: boolean }>('/api/admin/integrations/curseforge', { apiKey: value }),
    onSuccess: (result) => {
      setApiKey('');
      void queryClient.invalidateQueries({ queryKey: ['panel-settings'] });
      toast.push({
        tone: 'ok',
        message: result.configured
          ? 'CurseForge key saved. Browsing is on.'
          : 'CurseForge key removed.',
      });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        toast.push({ tone: 'danger', message: error.body.message, hint: error.body.hint });
      }
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>CurseForge</CardTitle>
            <CardDescription>
              Browse and search CurseForge mods from the Mods tab. Without a key
              the rest of the panel works exactly as it does now — you download
              from curseforge.com and upload the file yourself.
            </CardDescription>
          </div>
          <Badge tone={state.configured ? 'ok' : 'neutral'}>
            {state.configured ? 'On' : 'Off'}
          </Badge>
        </div>
      </CardHeader>

      <CardBody className="space-y-4">
        {state.source === 'environment' && (
          <div className="rounded-md border border-line border-l-2 border-l-accent bg-accent/[0.06] px-3 py-2.5">
            <p className="text-[12.5px] leading-relaxed text-ink-muted">
              A key is already set through <code>CURSEFORGE_API_KEY</code> in the
              environment. Saving one here takes precedence over it; clearing
              this field hands control back to the environment.
            </p>
          </div>
        )}

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(apiKey.trim());
          }}
        >
          <Field
            label="API key"
            help={
              state.source === 'panel'
                ? 'A key is stored. It is never shown again — paste a new one to replace it, or save an empty field to remove it.'
                : 'From console.curseforge.com under API Keys. Stored encrypted and never shown again.'
            }
          >
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={state.source === 'panel' ? '••••••••••••••••' : ''}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              variant="primary"
              loading={save.isPending}
              // Empty field with nothing stored is a no-op, not a "remove".
              disabled={apiKey.trim() === '' && state.source !== 'panel'}
            >
              {apiKey.trim() === '' && state.source === 'panel' ? 'Remove key' : 'Save key'}
            </Button>
            <a
              className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-subtle underline hover:text-ink"
              href="https://console.curseforge.com/"
              target="_blank"
              rel="noreferrer noopener"
            >
              Get a key
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
