import { defineConfig } from 'playwright/test';

// Per-project test directories: tests/e2e/{project}/*.spec.ts
// Run all:    npx playwright test
// Run one:    npx playwright test --project pando-node
const PROJECTS = ['pando-node', 'pando-code'];

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: 0, // No retries — we want to see real failures
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'https://gateway-one-mu.vercel.app',
    headless: false, // HEADED MODE — visible browser (E2E roadmap requirement)
    viewport: { width: 1280, height: 720 },
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    // Longer timeouts for real network requests
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: PROJECTS.map(name => ({
    name,
    testDir: `./tests/e2e/${name}`,
    use: { channel: 'chromium' },
  })),
});
