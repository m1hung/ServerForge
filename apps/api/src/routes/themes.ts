import type { FastifyInstance } from 'fastify';
import { badRequest, notFound } from '@serverforge/core';
import { requireRole } from '../lib/auth.js';
import { recordAudit } from '../lib/events.js';
import { getSetting, setSetting } from '../lib/settings.js';
import {
  DEFAULT_THEME_ID,
  listThemes,
  parseThemeId,
  readThemeCss,
} from '../lib/themes.js';

export const PANEL_THEME_KEY = 'panel.theme';

/**
 * Theme catalogue and CSS delivery.
 *
 * Listing and serving CSS are public so the dashboard can apply a theme on
 * the login page before a session exists. Changing the panel default is
 * admin-only.
 */
export async function themeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/themes', async () => {
    const themes = await listThemes();
    const stored = await getSetting<string>(PANEL_THEME_KEY, DEFAULT_THEME_ID);
    const active = parseThemeId(stored) ?? DEFAULT_THEME_ID;

    return {
      themes: [
        {
          id: DEFAULT_THEME_ID,
          name: 'Default',
          description: 'Built-in ServerForge light and dark tokens.',
          source: 'builtin' as const,
        },
        ...themes,
      ],
      active,
    };
  });

  app.get<{ Params: { id: string } }>('/api/themes/:id', async (request, reply) => {
    const id = parseThemeId(request.params.id);
    if (!id) throw badRequest('That theme name is not valid.');
    if (id === DEFAULT_THEME_ID) {
      return reply
        .type('text/css; charset=utf-8')
        .header('Cache-Control', 'public, max-age=60')
        .send('/* default theme — no overrides */\n');
    }

    const css = await readThemeCss(id);
    if (css === null) throw notFound('Theme');

    return reply
      .type('text/css; charset=utf-8')
      .header('Cache-Control', 'public, max-age=30')
      .send(css);
  });

  app.put<{ Body: { theme?: string } }>('/api/themes/active', async (request) => {
    const actor = await requireRole(request, ['owner', 'admin']);
    const id = parseThemeId(request.body?.theme);
    if (!id) throw badRequest('Pick a theme from the list.');

    if (id !== DEFAULT_THEME_ID) {
      const css = await readThemeCss(id);
      if (css === null) throw notFound('Theme');
    }

    await setSetting(PANEL_THEME_KEY, id);
    await recordAudit({
      actorId: actor.id,
      action: 'settings.update',
      targetType: 'system',
      targetId: PANEL_THEME_KEY,
      ip: request.ip,
    });

    return { ok: true, active: id };
  });
}
