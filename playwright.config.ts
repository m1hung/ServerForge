import { defineConfig } from '@playwright/test';

const baseURL = process.env.SF_TEST_BROWSER_URL;
if (!baseURL || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseURL) || ['3000', '8080'].includes(new URL(baseURL).port))
  throw new Error('Browser tests require an isolated loopback installation; use npm run test:packaged.');
export default defineConfig({
  testDir: './tests/browser',
  timeout: 120000,
  expect: { timeout: 15000 },
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: process.env.SF_TEST_BROWSER_RESULT || 'data/release-tests/browser-results.json' }]],
  outputDir: process.env.SF_TEST_BROWSER_OUTPUT || 'data/release-tests/browser-output',
  use: { baseURL, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'off' },
});
