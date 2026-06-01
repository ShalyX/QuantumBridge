import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store } from './store.js';
import { startIrisWorker } from './iris-worker.js';

const PORT = Number(process.env.PORT || process.env.QUANTUM_API_PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const ALLOWED_CORS_ORIGINS = CORS_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
    });
    res.end(JSON.stringify(payload));
}

function applyCorsHeaders(req, res) {
    const requestOrigin = req.headers.origin;
    const allowAny = ALLOWED_CORS_ORIGINS.includes('*');
    const allowedOrigin = allowAny
        ? '*'
        : (requestOrigin && ALLOWED_CORS_ORIGINS.includes(requestOrigin)
            ? requestOrigin
            : (requestOrigin ? null : ALLOWED_CORS_ORIGINS[0]));

    if (allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return Boolean(allowedOrigin) || !requestOrigin;
}

function isFailureState(state) {
    return ['failed', 'recoverable', 'already_claimed'].includes(String(state || '').toLowerCase());
}

async function captureFailureTelemetry(transfer, payload = {}, source = 'api') {
    if (!transfer) return;
    const state = payload.state || transfer.state;
    const errorMessage = payload.errorMessage || payload.error_message || transfer.errorMessage;
    if (!isFailureState(state) && !errorMessage) return;

    const failureEvent = {
        source,
        state,
        route: `${transfer.from || payload.from || 'unknown'}->${transfer.to || payload.to || 'unknown'}`,
        burnTxHash: transfer.burnTxHash || payload.burnTxHash || payload.burn_tx_hash || null,
        mintTxHash: transfer.mintTxHash || payload.mintTxHash || payload.mint_tx_hash || null,
        errorMessage: errorMessage || null,
    };
    await store.appendTransferEvent(transfer.id, 'transfer.failure_captured', failureEvent);
    console.warn('[QuantumBridge Monitoring] transfer failure captured', {
        transferId: transfer.id,
        ...failureEvent,
    });
}

async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return {};
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        const error = new Error('Request body must be valid JSON');
        error.statusCode = 400;
        throw error;
    }
}

function getTransferIdFromPath(pathname, suffix = '') {
    const prefix = '/api/transfers/';
    if (!pathname.startsWith(prefix)) return null;
    const rest = pathname.slice(prefix.length);
    if (suffix && !rest.endsWith(suffix)) return null;
    const rawId = suffix ? rest.slice(0, -suffix.length) : rest;
    if (!rawId || rawId.includes('/')) return null;
    return decodeURIComponent(rawId);
}

function contentTypeFor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return {
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.ico': 'image/x-icon',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.map': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
    }[ext] || 'application/octet-stream';
}

async function serveStaticAsset(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return false;
    if (!existsSync(distDir)) return false;

    const decodedPath = decodeURIComponent(url.pathname);
    const requestedPath = decodedPath === '/' ? '/index.html' : decodedPath;
    const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, '');
    let filePath = path.resolve(distDir, `.${safePath}`);
    if (!filePath.startsWith(distDir)) {
        sendJson(res, 400, { error: 'Invalid path' });
        return true;
    }

    try {
        const fileStat = await stat(filePath);
        if (fileStat.isDirectory()) filePath = path.join(filePath, 'index.html');
    } catch {
        if (requestedPath.startsWith('/assets/')) return false;
        filePath = path.join(distDir, 'index.html');
    }

    if (!existsSync(filePath)) return false;
    res.writeHead(200, {
        'Content-Type': contentTypeFor(filePath),
        'Cache-Control': filePath.includes(`${path.sep}assets${path.sep}`)
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
    });
    if (req.method === 'HEAD') {
        res.end();
        return true;
    }
    createReadStream(filePath).pipe(res);
    return true;
}

const server = http.createServer(async (req, res) => {
    try {
        const corsAllowed = applyCorsHeaders(req, res);

        if (req.method === 'OPTIONS') {
            res.writeHead(corsAllowed ? 204 : 403);
            res.end();
            return;
        }
        if (!corsAllowed) {
            sendJson(res, 403, { error: 'Origin not allowed' });
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        if (req.method === 'GET' && url.pathname === '/api/health') {
            sendJson(res, 200, {
                ok: true,
                version: process.env.npm_package_version || null,
                database: store.kind,
                dbPath: store.dbPath,
                worker: process.env.QUANTUM_WORKER_DISABLED === '1' ? 'disabled' : 'enabled',
                time: new Date().toISOString(),
            });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/transfers') {
            const wallet = url.searchParams.get('wallet');
            const requestedScope = url.searchParams.get('scope');
            const scope = requestedScope === 'global' || (!requestedScope && !wallet) ? 'global' : 'wallet';
            const limit = Number.parseInt(url.searchParams.get('limit') || '500', 10);
            const transfers = await store.listTransfers({
                wallet: scope === 'global' ? null : wallet,
                limit,
            });
            sendJson(res, 200, { transfers, scope, limit });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/transfers') {
            const body = await readJson(req);
            const transfer = await store.upsertTransfer(body);
            await captureFailureTelemetry(transfer, body, 'api.upsert');
            sendJson(res, 201, { transfer });
            return;
        }

        const supportId = req.method === 'GET'
            ? getTransferIdFromPath(url.pathname, '/support-bundle')
            : null;
        if (supportId) {
            const bundle = await store.getSupportBundle(supportId);
            if (!bundle) {
                sendJson(res, 404, { error: 'Transfer not found' });
                return;
            }
            sendJson(res, 200, bundle);
            return;
        }

        const eventId = req.method === 'POST'
            ? getTransferIdFromPath(url.pathname, '/events')
            : null;
        if (eventId) {
            const body = await readJson(req);
            let transfer = await store.getTransfer(eventId);
            if (!transfer) {
                const context = body.payload?.transferContext || body.transferContext || {};
                transfer = await store.upsertTransfer({
                    ...context,
                    id: eventId,
                    recoveryId: context.recoveryId || eventId,
                    state: context.state || 'created',
                    metadata: {
                        ...(context.metadata || {}),
                        eventCreatedBeforeTransfer: true,
                    },
                });
            }
            await store.appendTransferEvent(transfer.id, body.type || 'transfer.event', body.payload || body);
            if (String(body.type || '').includes('failed') || String(body.type || '').includes('error')) {
                await captureFailureTelemetry(transfer, body.payload || body, 'api.event');
            }
            sendJson(res, 201, { ok: true });
            return;
        }

        const transferId = req.method === 'PATCH'
            ? getTransferIdFromPath(url.pathname)
            : null;
        if (transferId) {
            const body = await readJson(req);
            const transfer = await store.patchTransfer(transferId, body);
            await captureFailureTelemetry(transfer, body, 'api.patch');
            sendJson(res, 200, { transfer });
            return;
        }

        if (await serveStaticAsset(req, res, url)) return;

        sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
        const statusCode = error.statusCode || 500;
        sendJson(res, statusCode, {
            error: error instanceof Error ? error.message : String(error),
        });
    }
});

server.listen(PORT, HOST, () => {
    console.log(`[QuantumBridge API] listening on http://${HOST}:${PORT}`);
    console.log(`[QuantumBridge API] db: ${store.dbPath}`);
});

if (process.env.QUANTUM_WORKER_DISABLED !== '1') {
    startIrisWorker(store);
    console.log('[QuantumBridge Worker] Circle Iris polling enabled');
}
