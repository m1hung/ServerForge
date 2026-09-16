import { test, expect, type BrowserContext } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import axe from 'axe-core';
import { getAdapter } from '@serverforge/adapters';
import { accentVariables } from '../../apps/web/src/lib/theme';

test.describe.configure({ mode: 'serial' });
let auditOwnerCookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];

test('protected owner setup, invitations, account controls, networking and accessible layout', async ({
  page,
  browser,
}) => {
  const token = process.env.SF_TEST_SETUP_TOKEN;
  const password = process.env.SF_TEST_OWNER_PASSWORD;
  if (!token || !password)
    throw new Error('The isolated test launcher must supply fresh owner credentials.');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/login');
  await expect(page.locator('.login-form')).toHaveCSS('animation-name', 'sf-arrive');
  await page.getByLabel('One-time setup token').fill('incorrect-setup-token');
  await page.getByLabel('Display name', { exact: true }).fill('Release tester');
  await page.getByLabel('Username', { exact: true }).fill('release-owner');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /token/i })).toBeVisible();
  await page.getByLabel('One-time setup token').fill(token);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('link', { name: 'Workspace accounts', exact: true })).toBeVisible();
  const malformed = await page.request.post('/api/account/password', {
    headers: { origin: process.env.SF_TEST_BROWSER_URL!, 'content-type': 'application/json' },
    data: '{',
  });
  expect(malformed.status()).toBe(400);
  expect((await malformed.json()).error.code).toBe('bad_request');
  const dark = page.getByRole('switch', { name: 'Dark mode' });
  await dark.click();
  await expect(dark).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(dark).toHaveAttribute('aria-checked', 'true');
  const sidebar = await page.locator('#sidebar').elementHandle();
  await expect(page.locator('.page-heading')).toHaveCSS('animation-name', 'sf-arrive');
  await page.locator('.page-heading').evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
    element.addEventListener('animationstart', () => element.setAttribute('data-replayed', 'true'));
  });
  await page.getByRole('button', { name: 'Refresh servers' }).click();
  await expect(page.getByRole('button', { name: 'Refresh servers' })).toBeEnabled();
  await expect(page.locator('.page-heading')).not.toHaveAttribute('data-replayed');
  const guide = page.getByRole('button', { name: 'Quick start guide' });
  await guide.click();
  await expect(page.getByRole('dialog')).toHaveCSS('animation-name', 'sf-dialog');
  await page.keyboard.press('Escape');
  await expect(guide).toBeFocused();
  const navigationRequests: string[] = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest()) navigationRequests.push(request.url());
  });
  await page.getByRole('link', { name: 'Workspace accounts', exact: true }).click();
  await page.getByRole('button', { name: 'Create invitation link', exact: true }).click();
  const link = await page.getByLabel('Invitation link').inputValue();
  expect(link).toContain('/invite#');
  const member = await browser.newContext({ baseURL: process.env.SF_TEST_BROWSER_URL });
  const invited = await member.newPage();
  const visited: string[] = [];
  invited.on('request', (request) => visited.push(request.url()));
  await invited.goto(link);
  await expect(invited).toHaveURL('/invite');
  await invited.getByLabel('Username', { exact: true }).fill('release-member');
  await invited.getByLabel('Display name', { exact: true }).fill('Invited player');
  await invited.getByLabel('Password', { exact: true }).fill(password);
  await invited.getByRole('button', { name: 'Accept invitation', exact: true }).click();
  await expect(invited).toHaveURL('/');
  await expect(invited.getByRole('link', { name: 'Workspace accounts', exact: true })).toHaveCount(
    0,
  );
  expect(visited.some((url) => url.includes(link.split('#')[1]!))).toBe(false);
  await member.close();
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Account/, exact: false }).first()).toBeVisible();
  await page.getByRole('link', { name: 'System status', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Panel ready' })).toBeVisible();
  await page.getByRole('link', { name: 'Network & access', exact: true }).click();
  await expect(page).toHaveURL('/network');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Network & access.');
  await expect(
    page.getByRole('heading', { name: 'Your dashboard, anywhere', exact: true }),
  ).toBeVisible({ timeout: 30000 });
  expect(await sidebar!.evaluate((element) => element === document.querySelector('#sidebar'))).toBe(
    true,
  );
  await expect(dark).toHaveAttribute('aria-checked', 'true');
  expect(navigationRequests).toEqual([]);
  const screenshots = process.env.SF_TEST_BROWSER_OUTPUT;
  if (screenshots) {
    await fs.mkdir(screenshots, { recursive: true });
    await page.screenshot({
      path: path.join(screenshots, 'network-dark.png'),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await expect(page.getByRole('link', { name: 'Overview', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Toggle navigation' })).toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  if (screenshots)
    await page.screenshot({
      path: path.join(screenshots, 'network-mobile.png'),
      fullPage: true,
      animations: 'disabled',
    });
  expect(errors).toEqual([]);
});

test('real Minecraft installation, console, hardware, consistent backup and world restore', async ({
  page,
}) => {
  test.setTimeout(12 * 60 * 1000);
  const password = process.env.SF_TEST_OWNER_PASSWORD;
  if (!password) throw new Error('The isolated test launcher must supply owner credentials.');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('release-owner');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/');
  await page.goto('/deploy');
  await page.getByRole('button', { name: /Minecraft: Java Edition/ }).click();
  await page.getByLabel('Game edition').selectOption('vanilla');
  await page.getByLabel('Minecraft version').fill('1.20.1');
  await page.getByLabel('Panel name').fill('Browser qualification');
  await page.getByLabel('Memory (GiB)', { exact: true }).fill('2');
  await page.getByLabel('CPU cores', { exact: true }).fill('2');
  await page.getByLabel('Storage budget (GiB)', { exact: true }).fill('4');
  await page.getByRole('checkbox', { name: /I accept the/ }).check();
  await page.getByRole('button', { name: 'Create server', exact: true }).click();
  await expect(page).toHaveURL(/\/servers\/[a-z0-9]+$/, { timeout: 30000 });
  const start = page.getByRole('button', { name: 'Start server', exact: true });
  await expect(start).toBeEnabled({ timeout: 240000 });
  await start.click();
  const logs = page.getByRole('log', { name: 'Server console logs' });
  await expect(logs).toContainText('Done (', { timeout: 180000 });
  const cheatSheet = page.getByRole('button', { name: 'Command cheat sheet', exact: true });
  const commands = page.getByRole('dialog', { name: 'Command cheat sheet', exact: true });
  const consoleInput = page.getByLabel('Console command', { exact: true });
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/console'))
      sent.push(request.postData() || '');
  });
  await cheatSheet.click();
  await expect(commands.getByRole('searchbox', { name: 'Search commands' })).toBeFocused();
  await commands.getByRole('searchbox').fill('no-such-command');
  await expect(commands.getByRole('status')).toHaveText(
    'No matching commands. Try a command name or category.',
  );
  await commands.getByRole('searchbox').fill('broadcast');
  await commands.getByRole('button', { name: 'Insert say <message>', exact: true }).click();
  await expect(commands).not.toBeVisible();
  await expect(consoleInput).toBeFocused();
  await expect(consoleInput).toHaveValue('say <message>');
  expect(
    await consoleInput.evaluate((input: HTMLInputElement) =>
      input.value.slice(input.selectionStart!, input.selectionEnd!),
    ),
  ).toBe('<message>');
  expect(sent).toEqual([]);
  await page.keyboard.insertText('Hello from the command cheat sheet');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(logs).toContainText('Hello from the command cheat sheet');
  // Recalled commands are editable and never sent just by using the history keys.
  const sendsBeforeHistory = sent.length;
  await consoleInput.fill('say draft to keep');
  await consoleInput.press('ArrowUp');
  await expect(consoleInput).toHaveValue('say Hello from the command cheat sheet');
  await consoleInput.press('ArrowDown');
  await expect(consoleInput).toHaveValue('say draft to keep');
  expect(sent).toHaveLength(sendsBeforeHistory);
  await consoleInput.fill('');
  await page.getByLabel('Filter console logs').fill('Hello from the command cheat sheet');
  await expect(logs).not.toContainText('Done (');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download visible logs', exact: true }).click();
  const download = await downloadPromise;
  const downloaded = await fs.readFile((await download.path())!, 'utf8');
  expect(downloaded).toContain('Hello from the command cheat sheet');
  expect(downloaded).not.toContain('Done (');
  await page.getByLabel('Filter console logs').fill('no-line-matches-this-value');
  await expect(logs).toContainText('No matching lines');
  await expect(page.getByRole('button', { name: 'Download visible logs' })).toBeDisabled();
  await page.getByRole('button', { name: 'Clear log filter' }).click();
  await page.getByLabel('Console text size').selectOption('17');
  await page.getByRole('checkbox', { name: 'Wrap lines', exact: true }).uncheck();
  await expect(logs).toHaveCSS('font-size', '17px');
  await expect(logs).toHaveCSS('white-space', 'pre');
  await cheatSheet.click();
  await page.keyboard.press('Escape');
  await expect(cheatSheet).toBeFocused();
  async function command(text: string) {
    await page.getByLabel('Console command', { exact: true }).fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByLabel('Console command', { exact: true })).toHaveValue('');
  }
  await command('scoreboard objectives add sf_browser dummy');
  await command('scoreboard players set checkpoint sf_browser 14092026');
  await expect(logs).toContainText('14092026');
  const memory = page.getByRole('meter', { name: 'Memory usage as percentage of limit' });
  await expect
    .poll(async () => Number(await memory.getAttribute('aria-valuenow')))
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('CPU cores', { exact: true }).fill('1.5');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved. Restart the server' }),
  ).toBeVisible();
  await page.getByText('Compare saved and running limits', { exact: true }).click();
  const cpuRow = page
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: 'CPU', exact: true }) });
  await expect(cpuRow.getByRole('cell').nth(0)).toHaveText('1.5');
  await expect(cpuRow.getByRole('cell').nth(1)).toHaveText('2');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1),
  ).toBe(true);
  await page.getByRole('button', { name: 'Backups & restore', exact: true }).click();
  await page.getByLabel('Backup name').fill('Browser world checkpoint');
  await page.getByRole('button', { name: 'Back up now', exact: true }).click();
  const backup = page
    .locator('article.tool-list-item')
    .filter({ hasText: 'Browser world checkpoint' });
  await expect(backup).toContainText('Completed', { timeout: 180000 });
  const restore = backup.getByRole('button', { name: 'Restore', exact: true });
  await expect(restore).toBeEnabled({ timeout: 180000 });
  await restore.click();
  const dialog = page.getByRole('dialog', { name: 'Restore this backup?' });
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(restore).toBeFocused();
  await restore.click();
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Restore started.' })).toBeVisible();
  await expect(start).toBeEnabled({ timeout: 180000 });
  await start.click();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(logs).toContainText('Done (', { timeout: 180000 });
  await command('scoreboard players get checkpoint sf_browser');
  await expect(logs).toContainText('checkpoint has 14092026');
  await page.getByRole('switch', { name: 'Dark mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const screenshots = process.env.SF_TEST_BROWSER_OUTPUT;
  if (screenshots)
    await page.screenshot({
      path: path.join(screenshots, 'server-dark.png'),
      fullPage: true,
      animations: 'disabled',
    });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  if (screenshots)
    await page.screenshot({
      path: path.join(screenshots, 'server-mobile.png'),
      fullPage: true,
      animations: 'disabled',
    });
  await cheatSheet.click();
  await expect(commands).toBeVisible();
  expect(await commands.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  if (screenshots)
    await page.screenshot({
      path: path.join(screenshots, 'console-commands-mobile-dark.png'),
      animations: 'disabled',
    });
  await commands.getByRole('button', { name: 'Close command cheat sheet' }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(start).toBeEnabled({ timeout: 90000 });
  const backupsPath =
    new URL(page.url()).pathname.replace('/servers/', '/api/servers/') + '/backups';
  let failedOperation = true;
  await page.route(`**${backupsPath}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        busy: false,
        lastOperation: {
          action: failedOperation ? 'backup.failed' : 'backup.completed',
          message: failedOperation
            ? 'Not enough free storage. Free space before retrying.'
            : 'Backup ready: Recovered checkpoint',
          at: new Date().toISOString(),
        },
      },
    });
  });
  await page.getByRole('button', { name: 'Backups & restore', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Not enough free storage' }),
  ).toBeVisible();
  failedOperation = false;
  await expect(
    page.getByRole('status').filter({ hasText: 'Backup ready: Recovered checkpoint' }),
  ).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Not enough free storage' })).toHaveCount(
    0,
  );
  await page.unroute(`**${backupsPath}`);
  expect(errors).toEqual([]);
});

test('uploaded client export explains the failure and retains its ZIP for retry or removal', async ({
  page,
}) => {
  test.setTimeout(120000);
  const password = process.env.SF_TEST_OWNER_PASSWORD;
  if (!password) throw new Error('The isolated test launcher must supply owner credentials.');
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('release-owner');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/');
  await page.goto('/deploy');
  await page.getByRole('button', { name: /Minecraft: Java Edition/ }).click();
  await page.getByLabel('Game edition').selectOption('custom-modpack');
  await page
    .getByLabel('CurseForge server pack ZIP')
    .setInputFiles(path.resolve('tests/fixtures/client-profile-export.zip'));
  await page.getByLabel('Panel name').fill('Browser ZIP validation');
  await page.getByLabel('Memory (GiB)', { exact: true }).fill('0.5');
  await page.getByLabel('CPU cores', { exact: true }).fill('1');
  await page.getByLabel('Storage budget (GiB)', { exact: true }).fill('1');
  await page.getByRole('checkbox', { name: /I accept the/ }).check();
  await page.getByRole('button', { name: 'Create server', exact: true }).click();
  await expect(page).toHaveURL(/\/servers\/[a-z0-9]+$/, { timeout: 30000 });
  const progress = page.getByRole('region', { name: 'Installation progress' });
  await expect(progress).toContainText('CurseForge client/profile export', { timeout: 60000 });
  await expect(progress).toContainText('Your uploaded server pack is kept for retry.');
  const retry = progress.getByRole('button', { name: 'Retry installation', exact: true });
  await expect(retry).toBeEnabled();
  const response = page.waitForResponse(
    (value) => value.request().method() === 'POST' && value.url().endsWith('/installation/retry'),
  );
  await retry.click();
  expect((await response).ok()).toBe(true);
  await expect(progress).toContainText('CurseForge client/profile export', { timeout: 60000 });
  const remove = progress.getByRole('button', { name: 'Remove uploaded pack', exact: true });
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect(remove).toHaveCount(0);
  await expect(progress).not.toContainText('Your uploaded server pack is kept for retry.');
});

test('log-only game command references and missing console permission', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('release-owner');
  await page.getByLabel('Password', { exact: true }).fill(process.env.SF_TEST_OWNER_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/');
  const url = await page
    .getByRole('link', { name: /Browser qualification/ })
    .first()
    .getAttribute('href');
  if (!url) throw new Error('The browser game fixture is missing.');
  const actual = await (await page.request.get(`/api${url}`)).json();
  for (const gameId of ['palworld', 'valheim']) {
    // UI fixtures only: these games are not installed or qualified by this check.
    const adapter = getAdapter(gameId);
    const glossary = adapter.consoleGlossary!(adapter.variants[0]!.id);
    await page.route(`**/api${url}`, (route) =>
      route.fulfill({
        json: {
          server: {
            ...actual.server,
            gameId,
            state: 'running',
            console: { ...glossary, canRead: true },
          },
        },
      }),
    );
    await page.goto(url);
    await expect(page.getByLabel('Console command', { exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Command cheat sheet', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Command cheat sheet', exact: true });
    await expect(sheet).toContainText('This console is log-only.');
    await expect(sheet.getByRole('button', { name: /^Insert / })).toHaveCount(0);
    await expect(sheet.locator('li')).toHaveCount(glossary.commands.length);
    await sheet.getByRole('button', { name: 'Copy', exact: true }).first().click();
    await expect(sheet.getByRole('status').filter({ hasText: 'Copied' })).toBeAttached();
    await page.unroute(`**/api${url}`);
  }
  await page.route(`**/api${url}`, (route) =>
    route.fulfill({
      json: {
        server: {
          ...actual.server,
          console: { canRead: false, acceptsCommands: true, commands: [] },
        },
      },
    }),
  );
  await page.goto(url);
  await expect(page.getByRole('log')).toContainText('You need console permission');
  await expect(page.getByRole('button', { name: 'Command cheat sheet' })).toHaveCount(0);
});

test('accessible contrast, labels and responsive reflow across workspace pages', async ({
  page,
}) => {
  test.setTimeout(480000);
  const password = process.env.SF_TEST_OWNER_PASSWORD;
  if (!password) throw new Error('The isolated test launcher must supply owner credentials.');
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('release-owner');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/');
  const server = await page
    .getByRole('link', { name: /Browser qualification/ })
    .first()
    .getAttribute('href');
  if (!server?.startsWith('/servers/'))
    throw new Error('The real browser game fixture is missing.');
  const rows = [];
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 720, height: 450 },
    { width: 390, height: 844 },
    { width: 320, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark']) {
      for (const route of [
        '/',
        '/deploy',
        '/account',
        '/accounts',
        '/system',
        '/network',
        server,
        ...[
          'mods',
          'configuration',
          'backups',
          'files',
          'diagnostics',
          'updates',
          'schedules',
          'players',
          'access',
        ].map((tool) => `${server}#${tool}`),
      ]) {
        await page.goto(route);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        if (route === '/network')
          await expect(
            page.getByRole('heading', { name: 'Your dashboard, anywhere', exact: true }),
          ).toBeVisible({ timeout: 30000 });
        if (route === '/system')
          await expect(page.getByRole('heading', { name: 'Panel ready' })).toBeVisible();
        await page.addStyleTag({
          content: '*,*::before,*::after{transition:none!important;animation:none!important}',
        });
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          localStorage.setItem('serverforge-theme', theme);
          window.dispatchEvent(new StorageEvent('storage', { key: 'serverforge-theme' }));
        }, theme);
        await page.addScriptTag({ content: axe.source });
        if (process.env.SF_TEST_BROWSER_OUTPUT && viewport.width === 1440) {
          const name = route.startsWith(server)
            ? `server${route.slice(server.length).replace('#', '-')}`
            : route === '/'
              ? 'overview'
              : route.slice(1);
          await page.screenshot({
            path: path.join(process.env.SF_TEST_BROWSER_OUTPUT, `page-${name}-${theme}.png`),
            animations: 'disabled',
          });
        }
        if (route === server)
          await page.getByRole('button', { name: 'Command cheat sheet', exact: true }).click();
        const result = await page.evaluate(async () => {
          const api = (window as unknown as { axe: typeof axe }).axe;
          const result = await api.run(document, {
            runOnly: {
              type: 'tag',
              values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
            },
          });
          return {
            version: result.testEngine.version,
            violations: result.violations,
            incomplete: result.incomplete.map((item) => ({
              id: item.id,
              targets: item.nodes.map((node) => node.target),
            })),
          };
        });
        const reflow = await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        );
        rows.push({ route, theme, viewport, reflow, ...result });
        if (process.env.SF_TEST_BROWSER_OUTPUT)
          await fs.writeFile(
            path.join(process.env.SF_TEST_BROWSER_OUTPUT, 'accessibility.json'),
            JSON.stringify(
              {
                format: 'serverforge-browser-accessibility',
                version: 1,
                limitations: [
                  'Automated checks do not replace screen-reader, keyboard and manual browser-zoom testing. The 720px viewport models 200% desktop reflow.',
                ],
                rows,
              },
              null,
              2,
            ),
          );
        expect(
          reflow,
          `${theme} ${route} at ${viewport.width}px must not overflow horizontally`,
        ).toBe(true);
        expect(result.violations, `${theme} ${route} at ${viewport.width}px`).toEqual([]);
      }
    }
  }
});

test('simple scheduling, shared server access, and member-facing controls', async ({
  page,
  browser,
}) => {
  const password = process.env.SF_TEST_OWNER_PASSWORD!;
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('release-owner');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/');
  const url = await page
    .getByRole('link', { name: /Browser qualification/ })
    .first()
    .getAttribute('href');
  if (!url) throw new Error('The browser game fixture is missing.');
  await page.goto(`${url}#schedules`);
  await expect(
    page.getByRole('button', { name: 'Schedules & alerts', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'New schedule', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Weekly UI backup');
  await page.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('weekly');
  await page.getByLabel('Run at', { exact: true }).fill('03:15');
  await page.getByRole('combobox', { name: 'Day', exact: true }).selectOption('1');
  await page.getByRole('textbox', { name: /^Timezone/ }).fill('UTC');
  await page.getByLabel('Enabled', { exact: true }).uncheck();
  await expect(page.getByLabel('Five-field cron', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save schedule', exact: true }).click();
  const schedule = page.locator('article.tool-list-item').filter({ hasText: 'Weekly UI backup' });
  await expect(schedule).toBeVisible();
  await expect(schedule).toContainText('Every Monday at 03:15 · UTC');
  const data = await (await page.request.get(`/api${url}/schedules`)).json();
  expect(
    data.schedules.find((item: { name: string }) => item.name === 'Weekly UI backup'),
  ).toMatchObject({ cron: '15 3 * * 1', timezone: 'UTC', enabled: false });
  await schedule.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Repeat', exact: true })).toHaveValue('weekly');
  await expect(page.getByLabel('Run at', { exact: true })).toHaveValue('03:15');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Shared access', exact: true }).click();
  await page.getByLabel('Panel username', { exact: true }).fill('release-member');
  await page.getByRole('button', { name: 'Save access', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Server access saved.' })).toBeVisible();
  const context = await browser.newContext({ baseURL: process.env.SF_TEST_BROWSER_URL });
  const member = await context.newPage();
  await member.goto('/login');
  await member.getByLabel('Username', { exact: true }).fill('release-member');
  await member.getByLabel('Password', { exact: true }).fill(password);
  await member.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(member).toHaveURL('/');
  await expect(member.getByRole('link', { name: /Deploy|Create a server/ })).toHaveCount(0);
  await member.goto(url);
  await expect(member.getByRole('button', { name: 'Start server', exact: true })).toBeDisabled();
  await expect(member.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
  await expect(member.getByRole('button', { name: 'Files', exact: true })).toHaveCount(0);
  await expect(member.getByRole('log')).toContainText('You need console permission');
  await member.goto(`${url}#files`);
  await expect(
    member.getByRole('heading', { name: 'Access to this tool is required' }),
  ).toBeVisible();
  await member.getByRole('button', { name: 'Back to server overview' }).click();
  await expect(member.getByRole('log')).toContainText('You need console permission');
  await member.goto('/deploy');
  await expect(
    member.getByRole('heading', { name: 'Administrator access required' }),
  ).toBeVisible();
  await context.close();
});

test('sharing explains unavailable connections and lets a failed lookup be retried', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('release-owner');
  await page.getByLabel('Password', { exact: true }).fill(process.env.SF_TEST_OWNER_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/');
  await page
    .getByRole('link', { name: /Browser qualification/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Browser qualification.');
  let fail = true;
  await page.route('**/api/servers/*/connections', (route) =>
    fail
      ? route.fulfill({
          status: 503,
          json: { error: { message: 'Temporary connection lookup failure.' } },
        })
      : route.continue(),
  );
  const share = page.getByRole('button', { name: 'Share', exact: true });
  await share.click();
  await expect(page.getByRole('group', { name: 'Connection type' })).toBeVisible();
  const dialog = page.getByRole('dialog', { name: 'Share Browser qualification', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('Temporary connection lookup failure.');
  await expect(dialog.getByRole('status')).toHaveText('Connection details are unavailable.');
  fail = false;
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(dialog).toContainText('Details checked');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(dialog).toContainText('Details checked');
  await dialog.getByRole('button', { name: 'Tailscale', exact: true }).click();
  await expect(dialog).toContainText('Set up this connection first');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(
    async () =>
      (
        await (window as unknown as { axe: typeof axe }).axe.run(document, {
          runOnly: {
            type: 'tag',
            values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
          },
        })
      ).violations,
  );
  expect(violations).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(share).toBeFocused();
});

test('invitation presets grant the selected server tools without administrator access', async ({
  page,
  browser,
}) => {
  const password = process.env.SF_TEST_OWNER_PASSWORD!;
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('release-owner');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/');
  const serverUrl = await page
    .getByRole('link', { name: /Browser qualification/ })
    .first()
    .getAttribute('href');
  if (!serverUrl) throw new Error('The browser game fixture is missing.');
  await page.getByRole('link', { name: 'Workspace accounts', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Browser qualification', exact: true }).check();
  await page.getByRole('combobox', { name: 'Access level', exact: true }).selectOption('operate');
  await page.getByRole('button', { name: 'Create invitation link', exact: true }).click();
  const link = await page.getByLabel('Invitation link').inputValue();
  const context = await browser.newContext({ baseURL: process.env.SF_TEST_BROWSER_URL });
  const operator = await context.newPage();
  await operator.goto(link);
  await operator.getByLabel('Username', { exact: true }).fill('release-operator');
  await operator.getByLabel('Display name', { exact: true }).fill('Server operator');
  await operator.getByLabel('Password', { exact: true }).fill(password);
  await operator.getByRole('button', { name: 'Accept invitation', exact: true }).click();
  await expect(operator).toHaveURL('/');
  await operator
    .getByRole('link', { name: /Browser qualification/ })
    .first()
    .click();
  await expect(operator.getByRole('button', { name: 'Start server', exact: true })).toBeEnabled();
  await expect(operator.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
  await expect(operator.getByRole('link', { name: 'Workspace accounts', exact: true })).toHaveCount(
    0,
  );
  const result = await (await operator.request.get(`/api${serverUrl}`)).json();
  expect(result.server.permissions.sort()).toEqual([
    'server.console',
    'server.power',
    'server.view',
  ]);
  await context.close();
});

test('account security prompts, authenticator recovery, scoped keys and password changes', async ({
  page,
  playwright,
}) => {
  const password = process.env.SF_TEST_OWNER_PASSWORD!;
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('release-member');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/');
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  const setup = page.getByRole('button', { name: 'Set up authenticator', exact: true });
  await setup.click();
  let dialog = page.getByRole('dialog', { name: 'Set up authenticator', exact: true });
  await expect(dialog.getByLabel('Current password', { exact: true })).toBeFocused();
  await expect(dialog.getByLabel('Authenticator or recovery code')).toHaveCount(0);
  await dialog.getByLabel('Current password', { exact: true }).fill('wrong password');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(setup).toBeFocused();
  await setup.click();
  await expect(dialog.getByLabel('Current password', { exact: true })).toHaveValue('');
  await dialog.getByLabel('Current password', { exact: true }).fill(password);
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByText('Manual setup key', { exact: true }).click();
  const secret = await page.locator('.enrollment-panel code').innerText();
  const { totp } = await import('../../apps/api/src/lib/totp');
  await page.getByRole('button', { name: 'Confirm authenticator', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Confirm authenticator', exact: true });
  await dialog.getByLabel('Current password', { exact: true }).fill(password);
  await dialog.getByLabel('Six-digit authenticator code', { exact: true }).fill(totp(secret));
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  const codes = (await page.locator('.secret-panel pre').innerText()).trim().split('\n');
  expect(codes.length).toBeGreaterThanOrEqual(8);
  await page.getByRole('button', { name: 'I saved it', exact: true }).click();
  await page.getByText('Create an API key', { exact: true }).click();
  await page.getByLabel('Key name', { exact: true }).fill('UI scoped key');
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Create API key', exact: true });
  await dialog.getByLabel('Current password', { exact: true }).fill(password);
  await dialog.getByLabel('Authenticator or recovery code', { exact: true }).fill(codes[0]!);
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Save your new API key' })).toBeVisible();
  const key = (await page.locator('.secret-panel pre').innerText()).trim();
  const keyClient = await playwright.request.newContext({
    baseURL: process.env.SF_TEST_BROWSER_URL,
    extraHTTPHeaders: { authorization: `Bearer ${key}` },
  });
  expect((await keyClient.get('/api/servers')).status()).toBe(200);
  expect((await keyClient.get('/api/network')).status()).toBe(403);
  await page.getByRole('button', { name: 'I saved it', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke key', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Revoke API key', exact: true });
  await dialog.getByLabel('Current password', { exact: true }).fill(password);
  await dialog.getByLabel('Authenticator or recovery code', { exact: true }).fill(codes[1]!);
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revoke key', exact: true })).toHaveCount(0);
  expect((await keyClient.get('/api/servers')).status()).toBe(401);
  await keyClient.dispose();
  await page.getByLabel('New password', { exact: true }).fill(password + '-changed');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Change password', exact: true });
  await dialog.getByLabel('Current password', { exact: true }).fill(password);
  await dialog.getByLabel('Authenticator or recovery code', { exact: true }).fill(codes[2]!);
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page).toHaveURL('/login');
  await page.getByLabel('Username', { exact: true }).fill('release-member');
  await page.getByLabel('Password', { exact: true }).fill(password + '-changed');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Verification code', { exact: true }).fill(codes[3]!);
  await page.getByRole('button', { name: 'Verify and sign in', exact: true }).click();
  await expect(page).toHaveURL('/');
});

test('saved personal preferences, favorites, automatic appearance and storage recovery', async ({
  page,
  context,
  browser,
}) => {
  const password = process.env.SF_TEST_OWNER_PASSWORD;
  if (!password) throw new Error('The isolated test launcher must supply owner credentials.');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('release-owner');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/');
  const servers = (await (await page.request.get('/api/servers')).json()).servers as {
    uid: string;
    name: string;
  }[];
  expect(servers.length).toBeGreaterThan(0);
  const server = servers[0]!;
  const copyAddress = page.getByRole('button', {
    name: `Copy ${server.name} address`,
    exact: true,
  });
  await copyAddress.click();
  await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toBeAttached();
  await expect(copyAddress).toHaveText('');
  await expect(copyAddress).toHaveAttribute('data-copied', 'true');
  await page.getByRole('button', { name: `Favorite ${server.name}`, exact: true }).click();
  await page.getByLabel('Sort servers').selectOption('favorites');
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  await expect(page.locator('.server-grid-card').first()).toContainText(server.name);
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(page.locator('.server-grid-card')).toHaveCount(1);
  await page.getByRole('link', { name: 'Customize', exact: true }).click();
  await expect(page).toHaveURL('/account#preferences');
  await page.getByRole('combobox', { name: 'Spacing', exact: true }).selectOption('compact');
  await page.getByText('Overview display', { exact: true }).click();
  await page.getByRole('checkbox', { name: /Show overview statistics/ }).uncheck();
  await page.getByRole('checkbox', { name: /Reduce animation/ }).check();
  await expect(page.locator('.page-heading')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('body')).toHaveCSS('transition-duration', '0s');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('checkbox', { name: /Reduce animation/ }).uncheck();
  await expect(page.locator('.page-heading')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('body')).toHaveCSS('transition-duration', '0s');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.page-heading')).toHaveCSS('animation-name', 'sf-arrive');
  await page.getByRole('checkbox', { name: /Reduce animation/ }).check();
  await page.getByText('Console display', { exact: true }).click();
  await page.getByLabel('Console text size').selectOption('15');
  await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('switch', { name: 'Dark mode' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('switch', { name: 'Dark mode' }).click();
  await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toHaveValue('dark');
  if (process.env.SF_TEST_BROWSER_OUTPUT) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(process.env.SF_TEST_BROWSER_OUTPUT, 'preferences-compact-dark.png'),
    });
  }
  const otherTab = await context.newPage();
  await otherTab.goto('/account');
  await expect(otherTab.getByRole('combobox', { name: 'Spacing', exact: true })).toHaveValue(
    'compact',
  );
  await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('light');
  await expect(otherTab.locator('html')).toHaveAttribute('data-theme', 'light');
  await otherTab.close();
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Spacing', exact: true })).toHaveValue('compact');
  await expect(page.getByLabel('Console text size')).toHaveValue('15');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.locator('.stats-grid')).toHaveCount(0);
  await expect(page.getByLabel('Sort servers')).toHaveValue('favorites');
  await expect(
    page.getByRole('button', { name: `Unfavorite ${server.name}`, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Grid view' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  if (process.env.SF_TEST_BROWSER_OUTPUT)
    await page.screenshot({
      path: path.join(process.env.SF_TEST_BROWSER_OUTPUT, 'favorites-cards-light.png'),
      fullPage: true,
    });
  await page.getByRole('link', { name: `Manage ${server.name}`, exact: true }).click();
  await expect(page.getByRole('log', { name: 'Server console logs' })).toHaveCSS(
    'font-size',
    '15px',
  );
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Reset display preferences' }).click();
  await expect(page.getByLabel('Default server view')).toHaveValue('auto');
  await expect(page.getByRole('combobox', { name: 'Spacing', exact: true })).toHaveValue(
    'comfortable',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Grid view' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    page.getByRole('button', { name: `Unfavorite ${server.name}`, exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  // A malformed old value cannot break login or prevent changing preferences.
  await page.evaluate(() => {
    localStorage.setItem('serverforge-preferences-v1', '{broken');
    localStorage.setItem('serverforge-theme', 'dark');
  });
  await page.goto('/account');
  await expect(page.getByRole('combobox', { name: 'Spacing', exact: true })).toHaveValue(
    'comfortable',
  );
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('Blocked', 'SecurityError');
    };
  });
  await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(
    page.getByRole('alert').filter({ hasText: /couldn’t save these preferences/ }),
  ).toBeVisible();
  // Appearance must be applied before hydration, including when JavaScript bundles are blocked.
  const noHydration = await browser.newContext({
    baseURL: process.env.SF_TEST_BROWSER_URL,
    colorScheme: 'dark',
  });
  await noHydration.route('**/_next/static/**', (route) => route.abort());
  const initial = await noHydration.newPage();
  await initial.goto('/login');
  await expect(initial.locator('html')).toHaveAttribute('data-theme', 'dark');
  await noHydration.close();
  auditOwnerCookies = await context.cookies();
  expect(errors).toEqual([]);
});

test('design audit: recoverable sign-in, mobile focus, empty states and visible copy failures', async ({
  page,
  context,
}) => {
  const password = process.env.SF_TEST_OWNER_PASSWORD;
  if (!password) throw new Error('The isolated test launcher must supply owner credentials.');
  await page.setViewportSize({ width: 320, height: 720 });
  let setupUnavailable = true;
  await page.route('**/api/setup', (route) =>
    setupUnavailable
      ? route.fulfill({
          status: 503,
          json: { error: { message: 'Setup service temporarily unavailable.' } },
        })
      : route.continue(),
  );
  await page.goto('/login');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Setup service temporarily unavailable.' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  setupUnavailable = false;
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  // Reuse the preceding workflow's session rather than exceeding production sign-in throttling.
  if (auditOwnerCookies.length) {
    await context.addCookies(auditOwnerCookies);
    await page.goto('/');
  } else {
    await page.getByLabel('Username', { exact: true }).fill('release-owner');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await expect(page).toHaveURL('/');
  const servers = (await (await page.request.get('/api/servers')).json()).servers as {
    uid: string;
    name: string;
  }[];
  const server = servers.find((server) => server.name === 'Browser qualification')!;
  expect(server).toBeTruthy();
  const url = `/servers/${server.uid}`;
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await expect(page.getByRole('dialog', { name: 'Workspace navigation' })).toBeVisible();
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('#sidebar'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Toggle navigation' })).toBeFocused();
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.workspace')).not.toHaveAttribute('inert');
  await expect(page.locator('#sidebar')).not.toHaveAttribute('aria-modal');
  await page.setViewportSize({ width: 320, height: 720 });
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('Clipboard denied');
        },
      },
    });
    document.execCommand = () => {
      throw new Error('Selection copying denied');
    };
  });
  const copy = page.getByRole('button', { name: `Copy ${server.name} address`, exact: true });
  await copy.click();
  await expect(page.locator('.copy-error')).toHaveText('Select the text to copy it.');
  await expect(copy).toBeFocused();
  await expect(page.getByLabel('Text to copy', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.goto(url + '#files');
  await page.getByRole('textbox', { name: 'Filter files' }).fill('no-such-file-for-design-audit');
  await expect(page.getByRole('status').filter({ hasText: /No files match/ })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filter', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Filter files' })).toHaveValue('');
  let finishPlayers!: () => void;
  const delayedPlayers = new Promise<void>((resolve) => {
    finishPlayers = resolve;
  });
  await page.route(`**/api/servers/${server.uid}/players`, async (route) => {
    await delayedPlayers;
    await route.fulfill({
      status: 503,
      json: { error: { message: 'Player service unavailable.' } },
    });
  });
  await page.getByRole('button', { name: 'Players', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Loading players…' })).toBeVisible();
  await expect(
    page.getByText('This game does not expose player join and leave events to the panel.'),
  ).toHaveCount(0);
  finishPlayers();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Player service unavailable.' }),
  ).toBeVisible();
  await page.unroute(`**/api/servers/${server.uid}/players`);
  await page.getByRole('button', { name: 'Retry loading' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Player service unavailable.' }),
  ).toHaveCount(0);
  await expect(
    page.getByText('This game does not expose player join and leave events to the panel.'),
  ).toHaveCount(0);
  const failed = servers.find((server) => server.name === 'Browser ZIP validation')!;
  // Restore intentionally leaves games offline; present an interrupted installation without mutating it.
  await page.route(`**/api/servers/${failed.uid}`, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.server.state = 'install_failed';
    await route.fulfill({ response, json: data });
  });
  let installationUnavailable = true;
  await page.route(`**/api/servers/${failed.uid}/installation`, (route) => {
    if (!installationUnavailable) return route.continue();
    return route.fulfill({
      status: 503,
      json: { error: { message: 'Installation check unavailable.' } },
    });
  });
  await page.goto(`/servers/${failed.uid}`);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Installation check unavailable.' }),
  ).toBeVisible();
  installationUnavailable = false;
  await expect(
    page.getByRole('alert').filter({ hasText: 'Installation check unavailable.' }),
  ).toHaveCount(0);
  // Read-only presentation fixture: a member with mod access must not be offered inaccessible tools.
  await page.route('**/api/me', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.user.role = 'user';
    await route.fulfill({ response, json: data });
  });
  let edition = 'minecraft-java';
  await page.route(`**/api/servers/${server.uid}`, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.server.gameId = edition;
    data.server.permissions = ['server.view', 'server.mods'];
    await route.fulfill({ response, json: data });
  });
  await page.goto(url + '#mods');
  await expect(
    page.getByText('Ask your workspace owner to deploy a mod-enabled edition.'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Deploy a server', exact: true })).toHaveCount(0);
  edition = 'minecraft-bedrock';
  await page.reload();
  await expect(
    page.getByText('Ask the server owner for file access to install add-ons.'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open files', exact: true })).toHaveCount(0);
});

test('public authentication layouts have consistent titles, contrast and narrow-screen reflow', async ({
  page,
}) => {
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      for (const route of ['/login', '/invite', '/invite#unverified-design-fixture']) {
        await page.goto(route);
        await expect(page.locator('.login-brand-panel .brand')).toBeVisible();
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.locator('h1 .heading-dot')).toHaveText('.');
        if (route === '/invite')
          await expect(
            page.getByRole('alert').filter({ hasText: 'Open the complete invitation link' }),
          ).toBeVisible();
        if (route.includes('#'))
          await expect(page.getByRole('button', { name: 'Accept invitation' })).toBeEnabled();
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          localStorage.setItem('serverforge-theme', theme);
          window.dispatchEvent(new StorageEvent('storage', { key: 'serverforge-theme' }));
        }, theme);
        await page.addStyleTag({
          content: '*,*::before,*::after{transition:none!important;animation:none!important}',
        });
        await page.addScriptTag({ content: axe.source });
        const violations = await page.evaluate(
          async () =>
            (
              await (window as unknown as { axe: typeof axe }).axe.run(document, {
                runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
              })
            ).violations,
        );
        expect(violations, `${route} ${theme} ${width}`).toEqual([]);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true);
      }
    }
  }
});

test('unsaved edits survive navigation, failed saves and history traversal; missing pages recover', async ({
  page,
  context,
}) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  if (auditOwnerCookies.length) {
    await context.addCookies(auditOwnerCookies);
    await page.goto('/');
  } else {
    await page.goto('/login');
    await page.getByLabel('Username', { exact: true }).fill('release-owner');
    await page.getByLabel('Password', { exact: true }).fill(process.env.SF_TEST_OWNER_PASSWORD!);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await expect(page).toHaveURL('/');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const servers = (await (await page.request.get('/api/servers')).json()).servers as {
    uid: string;
    name: string;
  }[];
  const server = servers.find((server) => server.name === 'Browser qualification')!;
  expect(server).toBeTruthy();
  const url = `/servers/${server.uid}`;
  const apiURL = `/api${url}`;
  const fileURL = `${apiURL}/files/content?path=%2Feula.txt`;
  const originalFile = (await (await page.request.get(fileURL)).json()) as {
    content: string;
    revision: string;
  };
  const modal = page.getByRole('dialog', { name: 'You have unsaved changes' });
  const account = () => page.getByRole('link', { name: 'Account', exact: true });
  try {
    await account().click();
    await expect(page).toHaveURL('/account');
    await page.getByRole('link', { name: 'Overview', exact: true }).click();
    await page.getByRole('link', { name: `Manage ${server.name}`, exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Panel name', { exact: true }).fill('Unsaved navigation draft');
    await account().click();
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Stay here' })).toBeFocused();
    await page.setViewportSize({ width: 320, height: 720 });
    await page.addScriptTag({ content: axe.source });
    expect(
      await page.evaluate(
        async () =>
          (await (window as unknown as { axe: typeof axe }).axe.run('.unsaved-dialog')).violations,
      ),
    ).toEqual([]);
    expect(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(page.getByLabel('Panel name', { exact: true })).toHaveValue(
      'Unsaved navigation draft',
    );
    const historyLength = await page.evaluate(() => history.length);
    await page.evaluate(() => history.go(-2));
    await expect(modal).toBeVisible();
    await expect(page).toHaveURL(url + '#configuration');
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    await modal.getByRole('button', { name: 'Stay here' }).click();
    // Browser reload/close retains the browser's native leave warning.
    let unloadWarning = false;
    page.once('dialog', async (dialog) => {
      unloadWarning = dialog.type() === 'beforeunload';
      await dialog.dismiss();
    });
    await page.reload({ timeout: 10000 }).catch(() => {});
    expect(unloadWarning).toBe(true);
    await expect(page.getByLabel('Panel name', { exact: true })).toHaveValue(
      'Unsaved navigation draft',
    );
    await page.route(`**${apiURL}`, (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({
            status: 503,
            json: { error: { message: 'Simulated save unavailable.' } },
          })
        : route.continue(),
    );
    await account().click();
    await modal.getByRole('button', { name: 'Save and leave' }).click();
    await expect(modal.getByRole('alert')).toContainText('Could not save');
    await expect(page).toHaveURL(url + '#configuration');
    await modal.getByRole('button', { name: 'Stay here' }).click();
    await page.unroute(`**${apiURL}`);
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await page.getByRole('button', { name: 'eula.txt', exact: true }).click();
    await page
      .getByLabel('File contents')
      .fill(originalFile.content + '\n# navigation save check\n');
    await account().click();
    await expect(modal).toContainText('Server settings');
    await expect(modal).toContainText('File: /eula.txt');
    await modal.getByRole('button', { name: 'Save and leave' }).click();
    await expect(page).toHaveURL('/account');
    expect((await (await page.request.get(apiURL)).json()).server.name).toBe(
      'Unsaved navigation draft',
    );
    expect((await (await page.request.get(fileURL)).json()).content).toContain(
      '# navigation save check',
    );
    // Back into the server, then Forward must also protect a fresh draft.
    await page.goBack();
    await expect(page).toHaveURL(url + '#files');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await account().click();
    await expect(page).toHaveURL('/account');
    await page.goBack();
    await expect(page).toHaveURL(url + '#configuration');
    await page.getByLabel('Panel name', { exact: true }).fill('Discarded forward draft');
    const beforeForward = await page.evaluate(() => history.length);
    await page.evaluate(() => history.forward());
    await expect(modal).toBeVisible();
    await expect(page).toHaveURL(url + '#configuration');
    await modal.getByRole('button', { name: 'Discard and leave' }).click();
    await expect(page).toHaveURL('/account');
    expect(await page.evaluate(() => history.length)).toBe(beforeForward);
    expect((await (await page.request.get(apiURL)).json()).server.name).toBe(
      'Unsaved navigation draft',
    );
    await page.goBack();
    await page.getByRole('button', { name: 'Schedules & alerts', exact: true }).click();
    await page.getByRole('button', { name: 'New schedule', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Unsaved schedule');
    await page.evaluate(() => history.back());
    await expect(modal).toBeVisible();
    await expect(page).toHaveURL(url + '#schedules');
    await modal.getByRole('button', { name: 'Stay here' }).click();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved schedule');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await skip.focus();
    await skip.press('Enter');
    await expect(page.locator('#main')).toBeFocused();
    await expect(page).toHaveURL(url + '#schedules');
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved schedule');
    await page.evaluate(() => {
      location.hash = 'players';
    });
    await expect(modal).toBeVisible();
    await expect(page).toHaveURL(url + '#schedules');
    await modal.getByRole('button', { name: 'Discard and leave' }).click();
    await expect(page).toHaveURL(url + '#players');
    await page.getByRole('button', { name: 'Shared access', exact: true }).click();
    await page.getByLabel('Panel username', { exact: true }).fill('unfinished-access');
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(modal).toContainText('Shared access');
    await modal.getByRole('button', { name: 'Discard and leave' }).click();
    await page.getByRole('link', { name: 'Deploy a server', exact: true }).click();
    await page.getByLabel(/^Panel name/).fill('Unfinished new server');
    await account().click();
    await expect(modal).toContainText('New server setup');
    await expect(modal.getByRole('button', { name: 'Save and leave' })).toHaveCount(0);
    await modal.getByRole('button', { name: 'Discard and leave' }).click();
    await expect(page).toHaveURL('/account');
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        for (const route of ['/this-page-does-not-exist', '/servers/zzzzzzzzzz']) {
          const response = await page.goto(route);
          if (route.startsWith('/this-')) expect(response?.status()).toBe(404);
          await expect(
            page.getByRole('heading', {
              name: route.startsWith('/this-') ? 'Page not found' : 'Server not found',
              level: 1,
            }),
          ).toBeVisible();
          await expect(page.locator('h1 .heading-dot')).toHaveText('.');
          await page.evaluate((theme) => {
            localStorage.setItem('serverforge-theme', theme);
            window.dispatchEvent(new StorageEvent('storage', { key: 'serverforge-theme' }));
          }, theme);
          await page.addStyleTag({
            content: '*,*::before,*::after{animation:none!important;transition:none!important}',
          });
          await page.addScriptTag({ content: axe.source });
          const violations = await page.evaluate(
            async () =>
              (
                await (window as unknown as { axe: typeof axe }).axe.run(document, {
                  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
                })
              ).violations,
          );
          expect(violations).toEqual([]);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          ).toBe(true);
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route(`**${apiURL}`, (route) =>
      route.fulfill({
        status: 503,
        json: { error: { message: 'Temporary server lookup failure.' } },
      }),
    );
    await page.goto(url);
    await expect(
      page.getByRole('heading', { name: 'Server unavailable', exact: true }),
    ).toBeVisible();
    await page.unroute(`**${apiURL}`);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Unsaved navigation draft', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Panel name', { exact: true }).fill('Reverted draft');
    await page.getByLabel('Panel name', { exact: true }).fill('Unsaved navigation draft');
    await page.getByRole('link', { name: 'Network & access', exact: true }).click();
    await expect(page).toHaveURL('/network');
    await expect(modal).toHaveCount(0);
    await page.locator('summary').filter({ hasText: 'Custom addresses' }).click();
    const publicHost = page.getByLabel(/^Public IP or hostname/);
    const savedHost = await publicHost.inputValue();
    await publicHost.fill('unsaved.example.test');
    await account().click();
    await expect(modal).toContainText('Network settings');
    await modal.getByRole('button', { name: 'Stay here' }).click();
    await publicHost.fill(savedHost);
    await expect(publicHost).toHaveValue(savedHost);
    await account().click();
    await expect(page).toHaveURL('/account');
    await expect(modal).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    const current = await (await page.request.get(fileURL)).json();
    expect(
      (
        await page.request.put(`${apiURL}/files/content`, {
          data: { path: '/eula.txt', content: originalFile.content, revision: current.revision },
        })
      ).ok(),
    ).toBe(true);
    expect((await page.request.patch(apiURL, { data: { name: server.name } })).ok()).toBe(true);
  }
});

test('simple settings retain advanced edits, reveal invalid fields and keep optional setup optional', async ({
  page,
  context,
}) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  if (auditOwnerCookies.length) {
    await context.addCookies(auditOwnerCookies);
    await page.goto('/');
  } else {
    await page.goto('/login');
    await page.getByLabel('Username', { exact: true }).fill('release-owner');
    await page.getByLabel('Password', { exact: true }).fill(process.env.SF_TEST_OWNER_PASSWORD!);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await expect(page).toHaveURL('/');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const servers = (await (await page.request.get('/api/servers')).json()).servers as {
    uid: string;
    name: string;
  }[];
  const server = servers.find((entry) => entry.name === 'Browser qualification')!;
  expect(server).toBeTruthy();
  const apiURL = `/api/servers/${server.uid}`;
  const saved = (await (await page.request.get(`${apiURL}/settings`)).json()).values;
  const patches: { settings: Record<string, unknown> }[] = [];
  await page.route(`**${apiURL}`, (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    patches.push(route.request().postDataJSON());
    return route.fulfill({ json: { restartRequired: false } });
  });
  await page.goto(`/servers/${server.uid}#configuration`);
  const save = page.getByRole('button', { name: 'Save changes', exact: true });
  const search = page.getByLabel('Find a game setting');
  const advanced = page
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: /^Advanced game settings/ }) });
  const expert = page
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: /^Expert game settings/ }) });
  await expect(save).toBeDisabled();
  await expect(advanced).not.toHaveAttribute('open');
  await expect(expert).not.toHaveAttribute('open');
  await search.fill('simulation-distance');
  await page.getByRole('button', { name: /^Simulation distance Performance/ }).click();
  const simulation = page.getByLabel('Simulation distance', { exact: false });
  await expect(simulation).toBeFocused();
  await expect(save).toBeDisabled();
  const distance = saved['simulation-distance'] === 6 ? 7 : 6;
  await simulation.fill(String(distance));
  await advanced.locator('summary').click();
  await search.fill('watchdog');
  await search.press('Enter');
  await expect(save).toBeEnabled();
  expect(patches).toEqual([]);
  await page.getByRole('button', { name: /^Watchdog timeout Performance/ }).click();
  const watchdog = page.getByLabel('Watchdog timeout', { exact: false });
  await expect(watchdog).toBeFocused();
  const timeout = saved['max-tick-time'] === -1 ? 60000 : -1;
  await watchdog.fill(String(timeout));
  await expect(simulation).toHaveValue(String(distance));
  await search.fill('enable-rcon');
  await page.getByRole('button', { name: /^Enable remote console/ }).click();
  const rcon = page.getByRole('checkbox', { name: 'Enable remote console (RCON)', exact: true });
  await rcon.uncheck();
  await search.fill('rcon.password');
  const dependent = page.getByRole('button', { name: /^RCON password Set Enable remote console/ });
  await expect(dependent).toContainText('to On first');
  await dependent.click();
  await expect(rcon).toBeFocused();
  await expect(rcon).not.toBeChecked();
  await search.fill('no-such-setting');
  await expect(page.getByRole('status').filter({ hasText: 'No matching settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toBeFocused();
  await advanced.locator('summary').click();
  await simulation.fill('');
  await advanced.locator('summary').click();
  await save.click();
  await expect(advanced).toHaveAttribute('open');
  await expect(simulation).toBeFocused();
  expect(patches).toEqual([]);
  await simulation.fill(String(distance));
  await advanced.locator('summary').click();
  await expert.locator('summary').click();
  await save.click();
  await expect(save).toBeDisabled();
  expect(patches).toHaveLength(1);
  expect(patches[0]!.settings).toEqual({
    'simulation-distance': distance,
    'max-tick-time': timeout,
    ...(saved['enable-rcon'] === true ? { 'enable-rcon': false } : {}),
  });
  await page.unroute(`**${apiURL}`);
  // The save is intercepted: this test never changes a game or its networking.
  expect((await (await page.request.get(`${apiURL}/settings`)).json()).values).toEqual(saved);
  const screenshots = process.env.SF_TEST_BROWSER_OUTPUT;
  if (screenshots)
    await page.screenshot({
      path: path.join(screenshots, 'settings-simple-desktop.png'),
      fullPage: true,
      animations: 'disabled',
    });
  await page.getByRole('link', { name: 'Deploy a server', exact: true }).click();
  const options = page
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: /^Game options/ }) });
  for (const name of [
    'Minecraft: Java Edition',
    'Minecraft: Bedrock Edition',
    'Valheim',
    'Palworld',
  ]) {
    await page.getByRole('button', { name, exact: false }).click();
    if (name.startsWith('Minecraft')) await expect(options).not.toHaveAttribute('open');
    else
      await expect(
        page.getByLabel(name === 'Valheim' ? 'Join password' : 'Admin password', { exact: true }),
      ).toBeVisible();
  }
  await page.getByRole('button', { name: /Minecraft: Java Edition/ }).click();
  await page.getByLabel('Game edition').selectOption('vanilla');
  await page.getByLabel(/^Panel name/).fill('Validation only');
  await page.getByRole('checkbox', { name: /I accept the/ }).check();
  await options.locator('summary').first().click();
  const viewDistance = page.getByLabel('View distance', { exact: false });
  await viewDistance.fill('1');
  await options.locator('summary').first().click();
  let creates = 0;
  await page.route('**/api/servers', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    creates++;
    return route.fulfill({
      status: 503,
      json: { error: { message: 'This test does not create a server.' } },
    });
  });
  await page.getByRole('button', { name: 'Create server', exact: true }).click();
  await expect(viewDistance).toBeFocused();
  await expect(options).toHaveAttribute('open');
  expect(creates).toBe(0);
  await viewDistance.fill('10');
  await page.getByLabel('Find a game setting').fill('simulation-distance');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      localStorage.setItem('serverforge-theme', theme);
      window.dispatchEvent(new StorageEvent('storage', { key: 'serverforge-theme' }));
    }, theme);
    await page.setViewportSize({ width: 320, height: 900 });
    expect((await page.getByLabel('Find a game setting').boundingBox())!.width).toBeGreaterThan(
      200,
    );
    await page.addStyleTag({
      content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await page.addScriptTag({ content: axe.source });
    expect(
      await page.evaluate(
        async () =>
          (
            await (window as unknown as { axe: typeof axe }).axe.run(document, {
              runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
            })
          ).violations,
      ),
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    if (screenshots)
      await page.screenshot({
        path: path.join(screenshots, `settings-search-${theme}-320.png`),
        fullPage: true,
        animations: 'disabled',
      });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: 'Network & access', exact: true }).click();
  await page.getByRole('button', { name: 'Discard and leave', exact: true }).click();
  await expect(page).toHaveURL('/network');
  const addresses = page
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: /^Custom addresses/ }) });
  await expect(addresses).not.toHaveAttribute('open');
  await expect(page.getByText('Port forwarding is off', { exact: true })).toBeVisible();
  await addresses.locator('summary').click();
  const publicHost = page.getByLabel(/^Public IP or hostname/);
  await publicHost.fill('discard.example.test');
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(publicHost).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Spacing', exact: true })).toBeVisible();
  await expect(page.getByLabel('Default server view')).toBeHidden();
  await page.locator('summary', { hasText: 'Overview display' }).click();
  await expect(page.getByLabel('Default server view')).toBeVisible();
  expect(errors).toEqual([]);
});

test('browser accents: color picker, keyboard, tab sync and display reset', async ({
  page,
  context,
}) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  if (auditOwnerCookies.length) await context.addCookies(auditOwnerCookies);
  else {
    await page.goto('/login');
    await page.getByLabel('Username', { exact: true }).fill('release-owner');
    await page.getByLabel('Password', { exact: true }).fill(process.env.SF_TEST_OWNER_PASSWORD!);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL('/');
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/account#preferences');
  const colors = ['#f97316', '#2563eb', '#16a34a', '#7c3aed', '#db2777', '#64748b'];
  await expect(page.getByRole('group', { name: 'Accent presets' })).toHaveCount(0);
  const root = page.locator('html');
  const hex = page.getByLabel('Hex color', { exact: true });
  const picker = page.getByLabel('Custom accent', { exact: true });
  const theme = page.getByRole('combobox', { name: 'Theme', exact: true });
  await page.addScriptTag({ content: axe.source });
  for (const mode of ['light', 'dark']) {
    await theme.selectOption(mode);
    for (const color of colors) {
      await picker.fill(color);
      await hex.focus();
      await expect(root).toHaveCSS('--accent', color!);
      await expect(hex).toHaveValue(color!);
      await expect(picker).toHaveValue(color!);
      const variables = accentVariables(color!);
      const rgb = (hex: string) =>
        `rgb(${[1, 3, 5].map((n) => parseInt(hex.slice(n, n + 2), 16)).join(', ')})`;
      await expect(page.locator('.heading-dot')).toHaveCSS(
        'color',
        rgb(variables[`--accent-mark-${mode}`]!),
      );
      await expect(page.locator('.brand-mark').first()).toHaveCSS(
        'color',
        rgb(variables['--accent-mark-dark']!),
      );
      await expect(hex).toHaveCSS('outline-color', rgb(variables[`--accent-ink-${mode}`]!));
      expect(
        await page.evaluate(
          async () =>
            (
              await (window as unknown as { axe: typeof axe }).axe.run('#preferences', {
                runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
              })
            ).violations,
        ),
      ).toEqual([]);
    }
  }
  await hex.fill('#ABCDEF');
  await expect(hex).toBeFocused();
  await expect(hex).toHaveValue('#abcdef');
  await expect(root).toHaveCSS('--accent', '#abcdef');
  await hex.fill('#zz');
  await expect(hex).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#accent-hex-hint')).toContainText(
    'Your last valid color is still active',
  );
  await expect(root).toHaveCSS('--accent', '#abcdef');
  await picker.fill('#112233');
  await expect(hex).toHaveValue('#112233');
  await expect(hex).toHaveAttribute('aria-invalid', 'false');
  await page.getByRole('switch', { name: 'Dark mode' }).click();
  await expect(root).toHaveCSS('--accent', '#112233');
  await expect(theme).toHaveValue('light');
  await theme.selectOption('system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(root).toHaveCSS('--accent', '#112233');
  const other = await context.newPage();
  await other.goto('/account');
  await expect(other.getByLabel('Hex color')).toHaveValue('#112233');
  await picker.fill('#db2777');
  await expect(other.getByLabel('Hex color')).toHaveValue('#db2777');
  await other.getByLabel('Hex color').fill('#010101');
  await expect(hex).toHaveValue('#010101');
  await other.close();
  await page.reload();
  await expect(hex).toHaveValue('#010101');
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('serverforge-preferences-v1')!);
    localStorage.setItem(
      'serverforge-preferences-v1',
      JSON.stringify({ ...saved, density: 'compact', favorites: ['keptfavorite'] }),
    );
    dispatchEvent(new StorageEvent('storage', { key: 'serverforge-preferences-v1' }));
  });
  await hex.fill('invalid');
  const resetAccent = page.getByRole('button', { name: 'Use workspace default', exact: true });
  await resetAccent.focus();
  await page.keyboard.press('Space');
  await expect(resetAccent).toBeFocused();
  await expect(hex).toHaveValue('#f97316');
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('serverforge-preferences-v1')!)),
  ).toMatchObject({ accentColor: null, density: 'compact', favorites: ['keptfavorite'] });
  await expect(root).toHaveCSS('--accent', '#f97316');
  await expect(root).toHaveAttribute('data-density', 'compact');
  await hex.fill('invalid');
  await page.getByRole('button', { name: 'Reset display preferences' }).click();
  await expect(hex).toHaveValue('#f97316');
  await expect(root).toHaveAttribute('data-density', 'comfortable');
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('serverforge-preferences-v1')!)),
  ).toMatchObject({
    accentColor: null,
    favorites: ['keptfavorite'],
    theme: 'system',
    density: 'comfortable',
  });
  // Narrow screens and extreme accents must retain legible controls without horizontal overflow.
  await page.setViewportSize({ width: 320, height: 900 });
  await page.addScriptTag({ content: axe.source });
  for (const mode of ['light', 'dark']) {
    await theme.selectOption(mode);
    for (const color of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff']) {
      await hex.fill(color);
      expect(
        await page.evaluate(
          async () =>
            (
              await (window as unknown as { axe: typeof axe }).axe.run(document, {
                runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
              })
            ).violations,
        ),
      ).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
    }
  }
  await picker.fill('#7c3aed');
  const screenshots = process.env.SF_TEST_BROWSER_OUTPUT;
  if (screenshots)
    await page.locator('#preferences').screenshot({
      path: path.join(screenshots, 'color-picker-dark-320.png'),
      animations: 'disabled',
    });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await theme.selectOption('light');
  await picker.fill('#2563eb');
  if (screenshots)
    await page.locator('#preferences').screenshot({
      path: path.join(screenshots, 'color-picker-light.png'),
      animations: 'disabled',
    });
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(root).toHaveCSS('--accent', '#2563eb');
  await page.getByRole('link', { name: 'Deploy a server', exact: true }).click();
  await expect(root).toHaveCSS('--accent', '#2563eb');
  await expect(page.getByRole('button', { name: /Minecraft: Java Edition/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('Blocked', 'SecurityError');
    };
  });
  await picker.fill('#16a34a');
  await expect(root).toHaveCSS('--accent', '#16a34a');
  await expect(
    page.getByRole('alert').filter({ hasText: /couldn’t save these preferences/ }),
  ).toBeVisible();
  auditOwnerCookies = await context.cookies();
  expect(errors).toEqual([]);
});

test('browser accents apply before hydration on dashboard and public recovery pages', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const isolated = await browser.newContext({
    baseURL: process.env.SF_TEST_BROWSER_URL,
    colorScheme: 'dark',
  });
  if (auditOwnerCookies.length) await isolated.addCookies(auditOwnerCookies);
  // Leave styles enabled while blocking client bundles: only the initial appearance script can run.
  await isolated.route('**/_next/static/**', (route) =>
    route.request().url().endsWith('.js') ? route.abort() : route.continue(),
  );
  const page = await isolated.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/login');
  for (const mode of ['light', 'dark']) {
    for (const stored of [
      '#2563eb',
      '#16a34a',
      '#7c3aed',
      '#db2777',
      '#64748b',
      '#FFFFFF',
      '#000000',
      'invalid',
      null,
    ]) {
      await page.evaluate(
        ({ accentColor, mode }) => {
          localStorage.setItem('serverforge-preferences-v1', JSON.stringify({ accentColor }));
          localStorage.setItem('serverforge-theme', mode);
        },
        { accentColor: stored, mode },
      );
      for (const route of ['/account', '/login', '/invite', '/missing-theme-page']) {
        await page.goto(route);
        await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
        await expect(page.locator('html')).toHaveCSS(
          '--accent',
          stored?.startsWith('#') ? stored.toLowerCase() : '#f97316',
        );
        expect(
          await page.locator('body').evaluate((body) => body.style.getPropertyValue('--accent')),
        ).toBe('');
      }
    }
  }
  await page.evaluate(() => localStorage.setItem('serverforge-preferences-v1', '{malformed'));
  await page.goto('/login');
  await expect(page.locator('html')).toHaveCSS('--accent', '#f97316');
  expect(errors).toEqual([]);
  await isolated.close();
});
