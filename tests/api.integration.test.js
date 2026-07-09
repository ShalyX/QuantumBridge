import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');

async function getFreePort() {
    const socket = net.createServer();
    await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
    const { port } = socket.address();
    await new Promise(resolve => socket.close(resolve));
    return port;
}

function startApi({ port, dbPath }) {
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], {
        cwd: projectRoot,
        env: {
            ...process.env,
            CORS_ORIGIN: 'https://allowed.example',
            DATABASE_URL: '',
            HOST: '127.0.0.1',
            PORT: String(port),
            QUANTUM_DB_PATH: dbPath,
            QUANTUM_WORKER_DISABLED: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    return { child, getOutput: () => output };
}

async function waitForApi(url, getOutput) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
            const response = await fetch(`${url}/api/health`);
            if (response.ok) return;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`API did not start:\n${getOutput()}`);
}

async function stopApi(child) {
    if (child.exitCode !== null) return;
    child.kill();
    await Promise.race([
        once(child, 'exit'),
        new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
}

test('transfer API enforces CORS and persists lifecycle history across restart', async t => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'quantum-bridge-api-'));
    const dbPath = path.join(tempDir, 'transfers.sqlite');
    const port = await getFreePort();
    const url = `http://127.0.0.1:${port}`;
    let api = startApi({ port, dbPath });

    t.after(async () => {
        await stopApi(api.child);
        await rm(tempDir, { recursive: true, force: true });
    });

    await waitForApi(url, api.getOutput);

    const health = await fetch(`${url}/api/health`).then(response => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.database, 'sqlite');
    assert.equal(health.worker, 'disabled');

    const allowedPreflight = await fetch(`${url}/api/transfers`, {
        method: 'OPTIONS',
        headers: {
            Origin: 'https://allowed.example',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type',
        },
    });
    assert.equal(allowedPreflight.status, 204);
    assert.equal(allowedPreflight.headers.get('access-control-allow-origin'), 'https://allowed.example');

    const denied = await fetch(`${url}/api/transfers`, {
        headers: { Origin: 'https://not-allowed.example' },
    });
    assert.equal(denied.status, 403);

    const malformed = await fetch(`${url}/api/transfers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://allowed.example' },
        body: '{',
    });
    assert.equal(malformed.status, 400);

    const transfer = {
        id: 'release-test-arc-solana',
        recoveryId: 'release-test-arc-solana',
        state: 'created',
        from: 'arc',
        to: 'solana',
        amount: '5.00',
        sourceWallet: '0x1111111111111111111111111111111111111111',
        destinationWallet: 'DestinationSolanaWallet11111111111111111111111',
        recipient: 'DestinationSolanaWallet11111111111111111111111',
        wallets: [
            '0x1111111111111111111111111111111111111111',
            'DestinationSolanaWallet11111111111111111111111',
        ],
        sourceDomain: 26,
        destinationDomain: 5,
        useForwarder: true,
    };

    const createdResponse = await fetch(`${url}/api/transfers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://allowed.example' },
        body: JSON.stringify(transfer),
    });
    assert.equal(createdResponse.status, 201);
    assert.equal((await createdResponse.json()).transfer.state, 'created');

    const burnHash = `0x${'a'.repeat(64)}`;
    const mintHash = `0x${'b'.repeat(64)}`;
    const completedResponse = await fetch(`${url}/api/transfers/${transfer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: 'https://allowed.example' },
        body: JSON.stringify({
            state: 'completed',
            burnTxHash: burnHash,
            mintTxHash: mintHash,
            metadata: { completedAt: '2026-06-20T12:00:37.000Z' },
        }),
    });
    assert.equal(completedResponse.status, 200);
    assert.equal((await completedResponse.json()).transfer.mintTxHash, mintHash);

    const duplicateResponse = await fetch(`${url}/api/transfers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://allowed.example' },
        body: JSON.stringify({
            ...transfer,
            id: 'duplicate-client-id',
            recoveryId: 'duplicate-client-id',
            state: 'completed',
            burnTxHash: burnHash,
            mintTxHash: mintHash,
        }),
    });
    assert.equal(duplicateResponse.status, 201);
    assert.equal((await duplicateResponse.json()).transfer.id, transfer.id);

    const secondRouteResponse = await fetch(`${url}/api/transfers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://allowed.example' },
        body: JSON.stringify({
            id: 'release-test-solana-ethereum',
            recoveryId: 'release-test-solana-ethereum',
            state: 'completed',
            from: 'solana',
            to: 'ethereum',
            amount: '7.5',
            sourceWallet: 'SourceSolanaWallet11111111111111111111111111',
            destinationWallet: '0x2222222222222222222222222222222222222222',
            recipient: '0x2222222222222222222222222222222222222222',
            wallets: [
                'SourceSolanaWallet11111111111111111111111111',
                '0x2222222222222222222222222222222222222222',
            ],
            burnTxHash: 'SolanaBurnSignature111111111111111111111111111111111111111111',
            mintTxHash: `0x${'c'.repeat(64)}`,
            useForwarder: true,
        }),
    });
    assert.equal(secondRouteResponse.status, 201);
    assert.equal((await secondRouteResponse.json()).transfer.state, 'completed');

    const failedBeforeBurn = {
        ...transfer,
        id: 'failed-before-burn-arc-solana',
        recoveryId: 'failed-before-burn-arc-solana',
        state: 'failed',
        burnTxHash: null,
        mintTxHash: null,
        errorMessage: 'Network request failed before the burn was submitted. Refresh, check your connection, and retry.',
    };
    const failedResponse = await fetch(`${url}/api/transfers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://allowed.example' },
        body: JSON.stringify(failedBeforeBurn),
    });
    assert.equal(failedResponse.status, 201);
    assert.equal((await failedResponse.json()).transfer.state, 'failed');

    const walletHistory = await fetch(
        `${url}/api/transfers?scope=wallet&wallet=${encodeURIComponent(transfer.sourceWallet)}`,
        { headers: { Origin: 'https://allowed.example' } },
    ).then(response => response.json());
    assert.equal(walletHistory.scope, 'wallet');
    assert.equal(walletHistory.transfers.length, 1);
    assert.equal(walletHistory.transfers[0].state, 'completed');

    const stats = await fetch(`${url}/api/stats`, {
        headers: { Origin: 'https://allowed.example' },
    }).then(response => response.json());
    assert.equal(stats.totalProcessedUsdc, '12.5');
    assert.equal(stats.completedTransfers, 2);
    assert.deepEqual(
        stats.routes.map(route => `${route.from}->${route.to}:${route.totalProcessedUsdc}:${route.completedTransfers}`).sort(),
        ['arc->solana:5:1', 'solana->ethereum:7.5:1'],
    );

    const failedSupportBundle = await fetch(`${url}/api/transfers/${failedBeforeBurn.id}/support-bundle`).then(response => response.json());
    assert.equal(failedSupportBundle.transfer.id, failedBeforeBurn.id);
    assert.equal(failedSupportBundle.transfer.state, 'failed');

    const supportBundle = await fetch(`${url}/api/transfers/${transfer.id}/support-bundle`).then(response => response.json());
    assert.equal(supportBundle.transfer.id, transfer.id);
    assert.ok(supportBundle.events.length >= 2);

    await stopApi(api.child);
    api = startApi({ port, dbPath });
    await waitForApi(url, api.getOutput);

    const afterRestart = await fetch(`${url}/api/transfers?scope=global`).then(response => response.json());
    assert.equal(afterRestart.transfers.length, 2);
    assert.ok(afterRestart.transfers.some(transfer => transfer.burnTxHash === burnHash && transfer.mintTxHash === mintHash));
});
