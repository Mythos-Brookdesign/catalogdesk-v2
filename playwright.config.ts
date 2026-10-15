import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: /auth\.spec\.ts/,
  fullyParallel: false,
  timeout: 30_000,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run dev:web',
    url: 'http://127.0.0.1:5179',
    reuseExistingServer: !process.env.CI,
  },
})
