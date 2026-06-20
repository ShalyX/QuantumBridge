import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const apiPort = 8788;
const webPort = 4173;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const testDbPath = path.join(os.tmpdir(), `quantum-bridge-playwright-${process.pid}.sqlite`);

export default defineConfig({
    testDir: './e2e',
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: webUrl,
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'], channel: 'chrome' },
        },
    ],
    webServer: [
        {
            command: 'node --no-warnings=ExperimentalWarning server/index.js',
            url: `${apiUrl}/api/health`,
            reuseExistingServer: !process.env.CI,
            timeout: 30_000,
            env: {
                CORS_ORIGIN: webUrl,
                DATABASE_URL: '',
                HOST: '127.0.0.1',
                PORT: String(apiPort),
                QUANTUM_DB_PATH: testDbPath,
                QUANTUM_WORKER_DISABLED: '1',
            },
        },
        {
            command: `npm run dev -- --host 127.0.0.1 --port ${webPort}`,
            url: webUrl,
            reuseExistingServer: !process.env.CI,
            timeout: 60_000,
            env: {
                VITE_API_PROXY_TARGET: apiUrl,
            },
        },
    ],
});
