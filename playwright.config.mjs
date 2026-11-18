import { defineConfig } from '@playwright/test';

const webPort = process.env.TEST_WEB_PORT ?? '4173';
const webURL = `http://127.0.0.1:${webPort}/creative-cooking/`;
const admissionURL = 'http://127.0.0.1:19482/';
const admissionSpecs = /loro-(file-binding|grant-review|selection)\.spec\.mjs$/;

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    browserName: 'chromium',
    serviceWorkers: 'allow',
    trace: 'retain-on-failure'
  },
  projects: [
    { name: 'web', testIgnore: admissionSpecs, use: { baseURL: webURL } },
    { name: 'loro-admission', testMatch: admissionSpecs, use: { baseURL: admissionURL } }
  ],
  webServer: [
    {
      command: 'node scripts/serve-dist.mjs',
      env: { PORT: webPort },
      url: webURL,
      reuseExistingServer: !process.env.CI,
      timeout: 20_000
    },
    {
      command: 'node src/loro/compromise/household-recipient-browser-server.mjs',
      env: { RECIPIENT_BROWSER_PORT: new URL(admissionURL).port },
      url: admissionURL,
      timeout: 20_000
    }
  ]
});
