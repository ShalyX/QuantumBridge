import { expect, test } from '@playwright/test';

test('core navigation, theme, wallet modal, and live status controls work', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/QuantumBridge/i);
    await expect(page.locator('[data-tab-panel="demo"]')).toBeVisible();

    await page.locator('[data-app-tab="bridge"]').click();
    await expect(page.locator('[data-tab-panel="bridge"]')).toBeVisible();

    await page.locator('#amount').fill('19.666');
    await page.locator('#destination-address').fill('68ihAknxEW5LA2y4ecgnFA7bpDvf8AaVUdyuBvY1q2wC');
    await expect(page.locator('#destination-address-hint')).toContainText('Receiving on Solana Devnet');

    await page.locator('#toggle-console').click();
    await expect(page.locator('#toggle-console')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.status-console')).toHaveClass(/collapsed/);

    await page.locator('#theme-toggle').click();
    await expect(page.locator('body')).toHaveClass(/light-theme/);

    await page.locator('#connect-evm').click();
    await expect(page.locator('#quantum-wallet-modal')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/modal-open/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#quantum-wallet-modal')).toBeHidden();

    await page.locator('[data-app-tab="activity"]').click();
    await expect(page.locator('[data-tab-panel="activity"]')).toBeVisible();
    await expect(page.locator('#activity-search')).toBeVisible();
});

test('backend transfer history survives a browser reload', async ({ page, request }) => {
    const id = `e2e-${Date.now()}-arc-solana`;
    const sourceWallet = '0x1111111111111111111111111111111111111111';
    const recipient = '68ihAknxEW5LA2y4ecgnFA7bpDvf8AaVUdyuBvY1q2wC';
    const burnTxHash = `0x${'a'.repeat(64)}`;
    const mintTxHash = `0x${'b'.repeat(64)}`;

    const response = await request.post('/api/transfers', {
        data: {
            id,
            recoveryId: id,
            state: 'completed',
            from: 'arc',
            to: 'solana',
            amount: '5.00',
            sourceWallet,
            destinationWallet: recipient,
            recipient,
            wallets: [sourceWallet, recipient],
            sourceDomain: 26,
            destinationDomain: 5,
            burnTxHash,
            mintTxHash,
            useForwarder: true,
            createdAt: '2026-06-20T12:00:00.000Z',
            metadata: { completedAt: '2026-06-20T12:00:37.000Z' },
        },
    });
    expect(response.ok()).toBeTruthy();

    await page.goto('/');
    await page.locator('[data-app-tab="activity"]').click();
    const activityPanel = page.locator('[data-tab-panel="activity"]');
    await expect(activityPanel).toContainText('5.00 USDC');
    await expect(activityPanel).toContainText('37s');

    await page.reload();
    await page.locator('[data-app-tab="activity"]').click();
    await expect(activityPanel).toContainText('5.00 USDC');
    await expect(activityPanel).toContainText('37s');
});
