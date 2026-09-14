import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import axe from 'axe-core';
import { getAdapter } from '@serverforge/adapters';

test.describe.configure({ mode: 'serial' });

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
  await page.goto('/login');
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
  await page.getByRole('button', { name: 'Configuration', exact: true }).click();
  await page.getByLabel('CPU cores', { exact: true }).fill('1.5');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved. Restart the server' }),
  ).toBeVisible();
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
  await expect(member.getByRole('button', { name: 'Configuration', exact: true })).toHaveCount(0);
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
  await expect(operator.getByRole('button', { name: 'Configuration', exact: true })).toHaveCount(0);
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
