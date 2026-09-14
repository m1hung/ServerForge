import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import axe from 'axe-core';

test.describe.configure({ mode: 'serial' });

test('protected owner setup, invitations, account controls, networking and accessible layout', async ({ page, browser }) => {
  const token = process.env.SF_TEST_SETUP_TOKEN;
  const password = process.env.SF_TEST_OWNER_PASSWORD;
  if (!token || !password) throw new Error('The isolated test launcher must supply fresh owner credentials.');
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
  await expect(invited.getByRole('link', { name: 'Workspace accounts', exact: true })).toHaveCount(0);
  expect(visited.some((url) => url.includes(link.split('#')[1]!))).toBe(false);
  await member.close();
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Account/, exact: false }).first()).toBeVisible();
  await page.getByRole('link', { name: 'System status', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Panel ready' })).toBeVisible();
  await page.getByRole('link', { name: 'Network & access', exact: true }).click();
  await expect(page).toHaveURL('/network');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Your servers, within reach.');
  await expect(page.getByRole('heading', { name: 'Your dashboard, anywhere', exact: true })).toBeVisible({ timeout: 30000 });
  const screenshots = process.env.SF_TEST_BROWSER_OUTPUT;
  if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, 'network-dark.png'), fullPage: true, animations: 'disabled' }); }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await expect(page.getByRole('link', { name: 'Overview', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Toggle navigation' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  if (screenshots) await page.screenshot({ path: path.join(screenshots, 'network-mobile.png'), fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('real Minecraft installation, console, hardware, consistent backup and world restore', async ({ page }) => {
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
  async function command(text: string) {
    await page.getByLabel('Console command', { exact: true }).fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByLabel('Console command', { exact: true })).toHaveValue('');
  }
  await command('scoreboard objectives add sf_browser dummy');
  await command('scoreboard players set checkpoint sf_browser 14092026');
  await expect(logs).toContainText('14092026');
  const memory = page.getByRole('meter', { name: 'Memory usage as percentage of limit' });
  await expect.poll(async () => Number(await memory.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Configuration', exact: true }).click();
  await page.getByLabel('CPU cores', { exact: true }).fill('1.5');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved. Restart the server' })).toBeVisible();
  const cpuRow = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'CPU', exact: true }) });
  await expect(cpuRow.getByRole('cell').nth(0)).toHaveText('1.5');
  await expect(cpuRow.getByRole('cell').nth(1)).toHaveText('2');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
  await page.getByLabel('More server tools').selectOption('backups');
  await page.getByLabel('Backup name').fill('Browser world checkpoint');
  await page.getByRole('button', { name: 'Back up now', exact: true }).click();
  const backup = page.locator('article.tool-list-item').filter({ hasText: 'Browser world checkpoint' });
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
  if (screenshots) await page.screenshot({ path: path.join(screenshots, 'server-dark.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  if (screenshots) await page.screenshot({ path: path.join(screenshots, 'server-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(start).toBeEnabled({ timeout: 90000 });
  expect(errors).toEqual([]);
});


test('uploaded client export explains the failure and retains its ZIP for retry or removal', async ({ page }) => {
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
  await page.getByLabel('CurseForge server pack ZIP').setInputFiles(path.resolve('tests/fixtures/client-profile-export.zip'));
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
  const response = page.waitForResponse((value) => value.request().method() === 'POST' && value.url().endsWith('/installation/retry'));
  await retry.click();
  expect((await response).ok()).toBe(true);
  await expect(progress).toContainText('CurseForge client/profile export', { timeout: 60000 });
  const remove = progress.getByRole('button', { name: 'Remove uploaded pack', exact: true });
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect(remove).toHaveCount(0);
  await expect(progress).not.toContainText('Your uploaded server pack is kept for retry.');
});


test('accessible contrast, labels and responsive reflow across workspace pages', async ({ page }) => {
  test.setTimeout(240000);
  const password = process.env.SF_TEST_OWNER_PASSWORD;
  if (!password) throw new Error('The isolated test launcher must supply owner credentials.');
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('release-owner');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/');
  const server = await page.getByRole('link', { name: /Browser qualification/ }).first().getAttribute('href');
  if (!server?.startsWith('/servers/')) throw new Error('The real browser game fixture is missing.');
  const rows = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 720, height: 450 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark']) {
      for (const route of ['/', '/deploy', '/account', '/accounts', '/system', '/network', server]) {
        await page.goto(route);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        if (route === '/network') await expect(page.getByRole('heading', { name: 'Your dashboard, anywhere', exact: true })).toBeVisible({ timeout: 30000 });
        if (route === '/system') await expect(page.getByRole('heading', { name: 'Panel ready' })).toBeVisible();
        await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; localStorage.setItem('serverforge-theme', theme); }, theme);
        await page.addScriptTag({ content: axe.source });
        const result = await page.evaluate(async () => {
          const api = (window as unknown as { axe: typeof axe }).axe;
          const result = await api.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
          return { version: result.testEngine.version, violations: result.violations, incomplete: result.incomplete.map((item) => ({ id: item.id, targets: item.nodes.map((node) => node.target) })) };
        });
        const reflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
        rows.push({ route, theme, viewport, reflow, ...result });
        if (process.env.SF_TEST_BROWSER_OUTPUT) await fs.writeFile(path.join(process.env.SF_TEST_BROWSER_OUTPUT, 'accessibility.json'), JSON.stringify({ format: 'serverforge-browser-accessibility', version: 1, limitations: ['Automated checks do not replace screen-reader, keyboard and manual browser-zoom testing. The 720px viewport models 200% desktop reflow.'], rows }, null, 2));
        expect(reflow, `${theme} ${route} at ${viewport.width}px must not overflow horizontally`).toBe(true);
        expect(result.violations, `${theme} ${route} at ${viewport.width}px`).toEqual([]);
      }
    }
  }
});
