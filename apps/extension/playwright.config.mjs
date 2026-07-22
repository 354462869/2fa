import { defineConfig, devices } from '@playwright/test';

const port = process.env.PLAYWRIGHT_PORT;
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR;

if (!port) {
  throw new Error('PLAYWRIGHT_PORT environment variable is required');
}
if (!outputDir) {
  throw new Error('PLAYWRIGHT_OUTPUT_DIR environment variable is required');
}

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'list',
  outputDir: outputDir,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'on-first-retry',
    viewport: { width: 320, height: 720 },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite preview --port ${port} --host 127.0.0.1 --strictPort`,
    url: `http://127.0.0.1:${port}/popup.html`,
    reuseExistingServer: false,
    timeout: 15000,
  },
});
