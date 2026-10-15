import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: /auth\.spec\.ts/,
  globalSetup: './tests/global-setup.ts',
  fullyParallel: false,
  timeout: 30_000,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
})
