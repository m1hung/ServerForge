import type { FastifyInstance } from 'fastify';
import { badRequest } from '@serverforge/core';
import { prisma } from '@serverforge/db';
import { requireRole } from '../lib/auth.js';
import { recordAudit } from '../lib/events.js';
import {
  getSetting,
  NETWORK_FORWARDING,
  setSetting,
  SETUP_COMPLETED,
} from '../lib/settings.js';
import {
  inspectNetwork,
  resolveNetworkChoice,
  type NetworkChoice,
  type ReachMode,
} from '../services/network.js';
import {
  clearDdnsConfig,
  getDdnsStatus,
  restartDdns,
  runDdnsUpdate,
  saveDdnsConfig,
  withExistingToken,
} from '../services/ddns.js';
import {
  DDNS_PROVIDERS,
  fullHostname,
  isDdnsProvider,
  type DdnsProviderId,
} from '../services/ddns-providers.js';
import { applyForwardingSetting } from '../services/upnp.js';

/**
 * First-run setup.
 *
 * Restricted to owner/admin: these endpoints report the panel's network
 * position and can ask the router to open a port, which is not something a
 * subuser with access to one server should be able to trigger.
 */
export async function setupRoutes(app: FastifyInstance): Promise<void> {
  /** What the panel can see about its own network position. Read-only. */
  app.get('/api/setup/network', async (request) => {
    await requireRole(request, ['owner', 'admin']);
    return inspectNetwork();
  });

  app.get('/api/setup/status', async (request) => {
    await requireRole(request, ['owner', 'admin']);
    return { completed: await getSetting<boolean>(SETUP_COMPLETED, false) };
  });

  /**
   * Dynamic DNS state. Returns the hostname and the last update result — never
   * the token, which is write-only from the browser's point of view.
   */
  app.get('/api/setup/ddns', async (request) => {
    await requireRole(request, ['owner', 'admin']);
    return { providers: DDNS_PROVIDERS, ...(await getDdnsStatus()) };
  });

  /** Publishes the current address immediately, for a "test now" button. */
  app.post('/api/setup/ddns/refresh', async (request) => {
    await requireRole(request, ['owner', 'admin']);
    return runDdnsUpdate();
  });

  app.delete('/api/setup/ddns', async (request) => {
    await requireRole(request, ['owner', 'admin']);
    await clearDdnsConfig();
    await restartDdns();
    return { configured: false };
  });

  /**
   * Applies a reachability choice.
   *
   * Writes the address players are given, and — only for a deliberate 'public'
   * choice — turns on automatic port forwarding. Choosing "my network only"
   * actively turns forwarding *off* rather than leaving whatever was there, so
   * moving from public back to private closes what was opened.
   */
  app.post('/api/setup/network', async (request) => {
    const user = await requireRole(request, ['owner', 'admin']);
    const body = request.body as {
      mode?: string;
      host?: string;
      complete?: boolean;
      ddns?: { provider?: string; hostname?: string; token?: string };
    };

    const modes: ReachMode[] = ['lan', 'vpn', 'public'];
    if (!body.mode || !modes.includes(body.mode as ReachMode)) {
      throw badRequest('Choose how people will connect.', 'Expected one of: lan, vpn, public.');
    }

    /**
     * A configured dynamic DNS name *is* the public address, so it wins over
     * anything typed in the address box. Anything else would let the two
     * disagree and hand players a name nobody is keeping up to date.
     */
    let ddnsHost: string | null = null;
    const ddns = body.ddns;
    if (ddns?.provider || ddns?.hostname || ddns?.token) {
      if (body.mode !== 'public') {
        throw badRequest('Dynamic DNS only applies when players connect over the internet.');
      }
      if (!isDdnsProvider(ddns.provider)) throw badRequest('Choose a dynamic DNS provider.');
      if (!ddns.hostname?.trim()) throw badRequest('Enter your dynamic DNS hostname.');

      ddnsHost = fullHostname(ddns.provider as DdnsProviderId, ddns.hostname);
    }

    const choice: NetworkChoice = {
      mode: body.mode as ReachMode,
      ...(ddnsHost ?? body.host ? { host: ddnsHost ?? body.host! } : {}),
    };

    const report = await inspectNetwork();
    const resolved = resolveNetworkChoice(choice, report);
    if (resolved.error || !resolved.publicHost) {
      throw badRequest(resolved.error ?? 'Could not work out an address to use.');
    }

    const node = await prisma.node.findFirst({ select: { id: true, uid: true } });
    if (!node) throw badRequest('No node is registered yet.', 'Run `npm run db:seed` first.');

    await prisma.node.update({ where: { id: node.id }, data: { publicHost: resolved.publicHost } });
    await setSetting(NETWORK_FORWARDING, resolved.forwarding);
    // Takes effect immediately: mappings for running servers are opened or
    // torn down here rather than at the next restart.
    await applyForwardingSetting(resolved.forwarding);

    // Publish the address straight away and report what happened. Saving a
    // wrong token and finding out hours later that the hostname never
    // resolved is the exact failure this whole feature exists to prevent.
    let ddnsResult: { ok: boolean; message: string; ip?: string } | null = null;
    if (ddns && ddnsHost) {
      const stored = await withExistingToken({
        provider: ddns.provider as DdnsProviderId,
        hostname: ddns.hostname!.trim(),
        token: ddns.token?.trim() ?? '',
      });

      if (!stored) {
        throw badRequest(
          'Enter the token for your dynamic DNS account.',
          'It is only remembered for the hostname it was saved against.',
        );
      }

      ddnsResult = await runDdnsUpdate(stored);
      // Only persist credentials that actually worked, so a typo cannot leave
      // the panel quietly retrying a broken token every fifteen minutes.
      if (ddnsResult.ok) {
        await saveDdnsConfig(stored);
        await restartDdns();
      }
    }

    if (body.complete !== false) await setSetting(SETUP_COMPLETED, true);

    await recordAudit({
      actorId: user.id,
      action: 'setup.network',
      targetType: 'node',
      targetId: node.uid,
      metadata: { mode: choice.mode, publicHost: resolved.publicHost, forwarding: resolved.forwarding },
    });

    return {
      publicHost: resolved.publicHost,
      forwarding: resolved.forwarding,
      gamePorts: report.gamePorts,
      ddns: ddnsResult,
    };
  });

  /** Dismisses the wizard without changing anything. */
  app.post('/api/setup/skip', async (request) => {
    await requireRole(request, ['owner', 'admin']);
    await setSetting(SETUP_COMPLETED, true);
    return { completed: true };
  });
}
