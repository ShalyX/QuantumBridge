import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const dataDir = process.env.QUANTUM_DATA_DIR || path.join(projectRoot, 'data');
const sqlitePath = process.env.QUANTUM_DB_PATH || path.join(dataDir, 'quantum-bridge.sqlite');
const postgresUrl = process.env.DATABASE_URL || '';

const TRANSFER_FIELDS = [
    'id',
    'recovery_id',
    'state',
    'from_chain',
    'to_chain',
    'amount',
    'recipient',
    'source_wallet',
    'destination_wallet',
    'wallets_json',
    'source_domain',
    'destination_domain',
    'burn_tx_hash',
    'mint_tx_hash',
    'use_forwarder',
    'already_minted',
    'error_message',
    'attestation_json',
    'metadata_json',
    'created_at',
    'updated_at',
    'last_checked_at',
];

function nowIso() {
    return new Date().toISOString();
}

function safeParse(value, fallback) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function cleanString(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text || null;
}

function safeJsonValue(value, seen = new WeakSet(), depth = 0) {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
    if (typeof value === 'bigint') return value.toString();
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
        };
    }
    if (seen.has(value)) return '[Circular]';
    if (depth > 8) return '[MaxDepth]';
    seen.add(value);
    if (Array.isArray(value)) return value.map(item => safeJsonValue(item, seen, depth + 1));
    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, safeJsonValue(item, seen, depth + 1)]),
    );
}

function clampListLimit(value, fallback = 500) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, 500);
}

function normalizeTransfer(input = {}, existing = null) {
    const timestamp = nowIso();
    const id = existing?.id || cleanString(input.id || input.recoveryId || input.recovery_id || input.burnTxHash || input.burn_tx_hash) ||
        `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const wallets = Array.isArray(input.wallets)
        ? input.wallets.filter(Boolean).map(String)
        : safeParse(existing?.wallets_json, []);
    const metadata = {
        ...safeParse(existing?.metadata_json, {}),
        ...(input.metadata || {}),
    };
    const attestation = input.attestation || input.attestationData || safeParse(existing?.attestation_json, null);
    const preserveUpdatedAt = Boolean(input.preserveUpdatedAt || input.preserve_updated_at);

    return {
        id,
        recovery_id: cleanString(input.recoveryId || input.recovery_id) || existing?.recovery_id || id,
        state: cleanString(input.state) || existing?.state || 'created',
        from_chain: cleanString(input.from || input.fromChain || input.from_chain) || existing?.from_chain || null,
        to_chain: cleanString(input.to || input.toChain || input.to_chain) || existing?.to_chain || null,
        amount: cleanString(input.amount) || existing?.amount || null,
        recipient: cleanString(input.recipient) || existing?.recipient || null,
        source_wallet: cleanString(input.sourceWallet || input.source_wallet) || existing?.source_wallet || null,
        destination_wallet: cleanString(input.destinationWallet || input.destination_wallet) || existing?.destination_wallet || null,
        wallets_json: JSON.stringify(wallets),
        source_domain: input.sourceDomain ?? input.source_domain ?? existing?.source_domain ?? null,
        destination_domain: input.destinationDomain ?? input.destination_domain ?? existing?.destination_domain ?? null,
        burn_tx_hash: cleanString(input.burnTxHash || input.burn_tx_hash) || existing?.burn_tx_hash || null,
        mint_tx_hash: cleanString(input.mintTxHash || input.mint_tx_hash) || existing?.mint_tx_hash || null,
        use_forwarder: Boolean(input.useForwarder ?? input.use_forwarder ?? existing?.use_forwarder),
        already_minted: Boolean(input.alreadyMinted ?? input.already_minted ?? existing?.already_minted),
        error_message: input.errorMessage === undefined ? (existing?.error_message || null) : cleanString(input.errorMessage),
        attestation_json: attestation ? JSON.stringify(attestation) : existing?.attestation_json || null,
        metadata_json: JSON.stringify(metadata),
        created_at: existing?.created_at || input.createdAt || input.created_at || timestamp,
        updated_at: preserveUpdatedAt ? (existing?.updated_at || input.updatedAt || input.updated_at || timestamp) : timestamp,
        last_checked_at: input.lastCheckedAt || input.last_checked_at || existing?.last_checked_at || null,
    };
}

function rowToTransfer(row) {
    if (!row) return null;
    const wallets = safeParse(row.wallets_json, []);
    return {
        id: row.id,
        recoveryId: row.recovery_id,
        state: row.state,
        from: row.from_chain,
        to: row.to_chain,
        amount: row.amount,
        recipient: row.recipient,
        sourceWallet: row.source_wallet,
        destinationWallet: row.destination_wallet,
        wallets: Array.isArray(wallets) ? wallets : [],
        sourceDomain: row.source_domain,
        destinationDomain: row.destination_domain,
        burnTxHash: row.burn_tx_hash,
        mintTxHash: row.mint_tx_hash,
        useForwarder: Boolean(row.use_forwarder),
        alreadyMinted: Boolean(row.already_minted),
        errorMessage: row.error_message,
        attestation: safeParse(row.attestation_json, null),
        metadata: safeParse(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastCheckedAt: row.last_checked_at,
    };
}

function lookupKeysFor(input = {}) {
    return [
        input.burnTxHash,
        input.burn_tx_hash,
        input.id,
        input.recoveryId,
        input.recovery_id,
    ].map(cleanString).filter(Boolean);
}

function filterTransfersByWallet(transfers, wallet) {
    if (!wallet) return transfers;
    const needle = wallet.toLowerCase();
    return transfers.filter(transfer => [
        transfer.sourceWallet,
        transfer.destinationWallet,
        transfer.recipient,
        ...(transfer.wallets || []),
    ].filter(Boolean).some(value => String(value).toLowerCase() === needle));
}

function toTime(value) {
    const time = new Date(value || '').getTime();
    return Number.isFinite(time) ? time : 0;
}

const MAX_REASONABLE_FILL_DURATION_MS = 30 * 60 * 1000;

function isLateSyncedCompletion(transfer) {
    const metadata = transfer.metadata || {};
    const completedAt = toTime(metadata.completedAt || metadata.finishedAt || metadata.forwarderConfirmedAt);
    const createdAt = toTime(transfer.createdAt);
    return completedAt > 0 && createdAt > 0 && completedAt - createdAt > MAX_REASONABLE_FILL_DURATION_MS;
}

function getTransferListSortTime(transfer) {
    const metadata = transfer.metadata || {};
    const terminal = transfer.state === 'completed' || transfer.state === 'already_claimed';
    if (terminal && isLateSyncedCompletion(transfer)) {
        return toTime(transfer.createdAt || transfer.updatedAt);
    }
    const candidates = terminal
        ? [
            metadata.completedAt,
            metadata.finishedAt,
            metadata.claimedAt,
            metadata.forwarderConfirmedAt,
            transfer.updatedAt,
            transfer.createdAt,
        ]
        : [transfer.updatedAt, transfer.createdAt];

    for (const candidate of candidates) {
        const time = toTime(candidate);
        if (time > 0) return time;
    }
    return 0;
}

function sortTransferList(transfers) {
    return [...transfers].sort((a, b) => getTransferListSortTime(b) - getTransferListSortTime(a));
}

function inferRouteFromTransferId(id = '') {
    const parts = String(id).toLowerCase().split('-');
    const chains = new Set(['arc', 'solana', 'ethereum']);
    const fromIndex = parts.findIndex(part => chains.has(part));
    if (fromIndex === -1 || !chains.has(parts[fromIndex + 1])) return {};
    return { from: parts[fromIndex], to: parts[fromIndex + 1] };
}

function extractTransferPatchFromEvents(transfer, events = []) {
    const inferredRoute = inferRouteFromTransferId(transfer.id);
    const patch = {
        from: transfer.from || inferredRoute.from || null,
        to: transfer.to || inferredRoute.to || null,
        wallets: Array.isArray(transfer.wallets) ? transfer.wallets : [],
        metadata: {
            ...(transfer.metadata || {}),
            backfilledFromEvents: true,
        },
    };
    let hasContext = Boolean(patch.from || patch.to || patch.wallets.length);
    const missingContext = !transfer.from ||
        !transfer.to ||
        !transfer.sourceWallet ||
        !(Array.isArray(transfer.wallets) && transfer.wallets.length);
    let hasLifecycleEvent = false;

    for (const event of events) {
        const payload = safeParse(event.payload_json, {});
        const context = payload.transferContext || {};
        if (context && typeof context === 'object') {
            patch.recoveryId = patch.recoveryId || context.recoveryId || context.id || transfer.recoveryId;
            patch.from = patch.from || context.from || null;
            patch.to = patch.to || context.to || null;
            patch.amount = patch.amount || context.amount || null;
            patch.recipient = patch.recipient || context.recipient || null;
            patch.sourceWallet = patch.sourceWallet || context.sourceWallet || null;
            patch.destinationWallet = patch.destinationWallet || context.destinationWallet || null;
            patch.sourceDomain = patch.sourceDomain ?? context.sourceDomain ?? null;
            patch.destinationDomain = patch.destinationDomain ?? context.destinationDomain ?? null;
            patch.burnTxHash = patch.burnTxHash || context.burnTxHash || null;
            patch.useForwarder = Boolean(patch.useForwarder || context.useForwarder);
            if (Array.isArray(context.wallets)) {
                patch.wallets = Array.from(new Set([...patch.wallets, ...context.wallets].filter(Boolean).map(String)));
            }
            hasContext = true;
        }

        const eventType = String(event.event_type || '').toLowerCase();
        const values = payload.values || {};
        if (values.txHash && eventType.includes('burn')) {
            hasLifecycleEvent = true;
            patch.burnTxHash = patch.burnTxHash || values.txHash;
            patch.state = patch.state || 'burn_submitted';
        }
        if (values.txHash && eventType.includes('mint')) {
            hasLifecycleEvent = true;
            patch.mintTxHash = values.txHash;
            patch.state = 'completed';
            patch.errorMessage = null;
        }

        const state = String(values.state || payload.state || '').toLowerCase();
        const isErrorEvent = eventType.includes('transfer.failed') ||
            eventType.includes('.error') ||
            state === 'error' ||
            state === 'failed';
        if (isErrorEvent) {
            hasLifecycleEvent = true;
            const eventBurnHash = cleanString(
                patch.burnTxHash ||
                context.burnTxHash ||
                payload.burnTxHash ||
                values.burnTxHash ||
                values.txHash,
            );
            const eventError = values.error || payload.error || {};
            const eventErrorMessage = cleanString(
                eventError.productMessage ||
                payload.productMessage ||
                values.errorMessage ||
                payload.errorMessage ||
                eventError.message ||
                payload.message ||
                transfer.errorMessage,
            );

            if (eventBurnHash) {
                patch.burnTxHash = patch.burnTxHash || eventBurnHash;
                if (!patch.mintTxHash) patch.state = 'recoverable';
            } else if (!patch.mintTxHash) {
                patch.state = 'failed';
            }
            if (!patch.mintTxHash) {
                patch.errorMessage = eventErrorMessage || patch.errorMessage || null;
            }
            hasContext = true;
        }
    }

    if (!hasContext && !patch.burnTxHash && !patch.mintTxHash) return null;
    if (transfer.state === 'created' && !hasLifecycleEvent && !missingContext) return null;
    return patch;
}

class SqliteStore {
    constructor(db, dbPath) {
        this.db = db;
        this.dbPath = dbPath;
        this.kind = 'sqlite';
    }

    static async create() {
        mkdirSync(dataDir, { recursive: true });
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(sqlitePath);
        db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS transfers (
                id TEXT PRIMARY KEY,
                recovery_id TEXT,
                state TEXT NOT NULL,
                from_chain TEXT,
                to_chain TEXT,
                amount TEXT,
                recipient TEXT,
                source_wallet TEXT,
                destination_wallet TEXT,
                wallets_json TEXT,
                source_domain INTEGER,
                destination_domain INTEGER,
                burn_tx_hash TEXT,
                mint_tx_hash TEXT,
                use_forwarder INTEGER DEFAULT 0,
                already_minted INTEGER DEFAULT 0,
                error_message TEXT,
                attestation_json TEXT,
                metadata_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_checked_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_transfers_burn_tx_hash ON transfers(burn_tx_hash);
            CREATE INDEX IF NOT EXISTS idx_transfers_state ON transfers(state);
            CREATE INDEX IF NOT EXISTS idx_transfers_source_wallet ON transfers(source_wallet);
            CREATE INDEX IF NOT EXISTS idx_transfers_destination_wallet ON transfers(destination_wallet);

            CREATE TABLE IF NOT EXISTS transfer_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                transfer_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload_json TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (transfer_id) REFERENCES transfers(id) ON DELETE CASCADE
            );

            DELETE FROM transfer_events
            WHERE transfer_id IN (
                SELECT t.id
                FROM transfers t
                WHERE t.burn_tx_hash IS NOT NULL
                  AND EXISTS (
                      SELECT 1
                      FROM transfers newer
                      WHERE newer.burn_tx_hash = t.burn_tx_hash
                        AND (
                            newer.updated_at > t.updated_at
                            OR (newer.updated_at = t.updated_at AND newer.rowid > t.rowid)
                        )
                  )
            );

            DELETE FROM transfers
            WHERE burn_tx_hash IS NOT NULL
              AND EXISTS (
                  SELECT 1
                  FROM transfers newer
                  WHERE newer.burn_tx_hash = transfers.burn_tx_hash
                    AND (
                        newer.updated_at > transfers.updated_at
                        OR (newer.updated_at = transfers.updated_at AND newer.rowid > transfers.rowid)
                    )
              );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_burn_tx_hash_unique
            ON transfers(burn_tx_hash)
            WHERE burn_tx_hash IS NOT NULL;
        `);
        return new SqliteStore(db, sqlitePath);
    }

    findTransferRow(id) {
        return this.db.prepare('SELECT * FROM transfers WHERE id = ? OR recovery_id = ? OR burn_tx_hash = ? LIMIT 1').get(id, id, id);
    }

    async getTransfer(id) {
        return rowToTransfer(this.findTransferRow(id));
    }

    async upsertTransfer(input) {
        let existing = null;
        for (const lookupKey of lookupKeysFor(input)) {
            existing = this.findTransferRow(lookupKey);
            if (existing) break;
        }
        const next = normalizeTransfer(input, existing);

        if (existing) {
            const assignments = TRANSFER_FIELDS.filter(field => field !== 'id')
                .map(field => `${field} = @${field}`)
                .join(', ');
            this.db.prepare(`UPDATE transfers SET ${assignments} WHERE id = @id`).run({
                ...next,
                use_forwarder: Number(next.use_forwarder),
                already_minted: Number(next.already_minted),
            });
        } else {
            const columns = TRANSFER_FIELDS.join(', ');
            const values = TRANSFER_FIELDS.map(field => `@${field}`).join(', ');
            this.db.prepare(`INSERT INTO transfers (${columns}) VALUES (${values})`).run({
                ...next,
                use_forwarder: Number(next.use_forwarder),
                already_minted: Number(next.already_minted),
            });
        }

        await this.appendTransferEvent(next.id, 'transfer.upserted', input);
        return this.getTransfer(next.id);
    }

    async patchTransfer(id, patch) {
        const existing = this.findTransferRow(id);
        return this.upsertTransfer({ ...(existing ? rowToTransfer(existing) : { id }), ...patch, id: existing?.id || id });
    }

    async listTransfers({ wallet, limit = 500 } = {}) {
        const safeLimit = clampListLimit(limit);
        const internalLimit = Math.max(safeLimit, 500);
        const rows = this.db.prepare('SELECT * FROM transfers ORDER BY updated_at DESC LIMIT ?').all(internalLimit);
        return sortTransferList(filterTransfersByWallet(rows.map(rowToTransfer), wallet)).slice(0, safeLimit);
    }

    async listTransfersForWorker() {
        const rows = this.db.prepare(`
            SELECT * FROM transfers
            WHERE burn_tx_hash IS NOT NULL
              AND (
                state IN ('burn_submitted', 'attestation_pending', 'recoverable')
                OR (use_forwarder = 1 AND mint_tx_hash IS NULL AND state NOT IN ('failed', 'already_claimed'))
                OR (already_minted = 1 AND state <> 'already_claimed')
              )
            ORDER BY updated_at ASC
            LIMIT 100
        `).all();
        return rows.map(rowToTransfer);
    }

    async appendTransferEvent(transferId, eventType, payload = {}) {
        if (!transferId || !eventType) return;
        const safePayload = safeJsonValue(payload);
        this.db.prepare(`
            INSERT INTO transfer_events (transfer_id, event_type, payload_json, created_at)
            VALUES (?, ?, ?, ?)
        `).run(transferId, eventType, JSON.stringify(safePayload), nowIso());
    }

    async backfillTransferContextsFromEvents() {
        const rows = this.db.prepare(`
            SELECT * FROM transfers
            WHERE (
                from_chain IS NULL
                OR to_chain IS NULL
                OR source_wallet IS NULL
                OR json_array_length(COALESCE(wallets_json, '[]')) = 0
                OR state = 'created'
            )
              AND (
                state = 'created'
                OR COALESCE(json_extract(metadata_json, '$.backfilledFromEvents'), 0) != 1
              )
            ORDER BY created_at DESC
            LIMIT 100
        `).all();
        for (const row of rows) {
            const transfer = rowToTransfer(row);
            const events = this.db.prepare('SELECT * FROM transfer_events WHERE transfer_id = ? ORDER BY created_at ASC').all(transfer.id);
            const patch = extractTransferPatchFromEvents(transfer, events);
            if (patch) await this.patchTransfer(transfer.id, patch);
        }
    }

    async getSupportBundle(id) {
        const transfer = await this.getTransfer(id);
        if (!transfer) return null;
        const events = this.db.prepare('SELECT * FROM transfer_events WHERE transfer_id = ? ORDER BY created_at ASC').all(transfer.id)
            .map(event => ({
                id: event.id,
                type: event.event_type,
                payload: safeParse(event.payload_json, {}),
                createdAt: event.created_at,
            }));
        return { transfer, events, generatedAt: nowIso() };
    }
}

class PostgresStore {
    constructor(pool) {
        this.pool = pool;
        this.dbPath = 'postgres';
        this.kind = 'postgres';
    }

    static async create() {
        const pool = new Pool({
            connectionString: postgresUrl,
            ssl: getPostgresSslConfig(postgresUrl),
        });
        const store = new PostgresStore(pool);
        await store.migrate();
        return store;
    }

    async migrate() {
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS transfers (
                id TEXT PRIMARY KEY,
                recovery_id TEXT,
                state TEXT NOT NULL,
                from_chain TEXT,
                to_chain TEXT,
                amount TEXT,
                recipient TEXT,
                source_wallet TEXT,
                destination_wallet TEXT,
                wallets_json JSONB,
                source_domain INTEGER,
                destination_domain INTEGER,
                burn_tx_hash TEXT,
                mint_tx_hash TEXT,
                use_forwarder BOOLEAN DEFAULT FALSE,
                already_minted BOOLEAN DEFAULT FALSE,
                error_message TEXT,
                attestation_json JSONB,
                metadata_json JSONB,
                created_at TIMESTAMPTZ NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL,
                last_checked_at TIMESTAMPTZ
            );

            CREATE INDEX IF NOT EXISTS idx_transfers_burn_tx_hash ON transfers(burn_tx_hash);
            CREATE INDEX IF NOT EXISTS idx_transfers_state ON transfers(state);
            CREATE INDEX IF NOT EXISTS idx_transfers_source_wallet ON transfers(source_wallet);
            CREATE INDEX IF NOT EXISTS idx_transfers_destination_wallet ON transfers(destination_wallet);

            CREATE TABLE IF NOT EXISTS transfer_events (
                id BIGSERIAL PRIMARY KEY,
                transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
                event_type TEXT NOT NULL,
                payload_json JSONB,
                created_at TIMESTAMPTZ NOT NULL
            );
        `);
        await this.pool.query(`
            DELETE FROM transfer_events
            WHERE transfer_id IN (
                SELECT id FROM (
                    SELECT id, ROW_NUMBER() OVER (
                        PARTITION BY burn_tx_hash
                        ORDER BY updated_at DESC, id DESC
                    ) AS rn
                    FROM transfers
                    WHERE burn_tx_hash IS NOT NULL
                ) duplicates
                WHERE rn > 1
            );
        `);
        await this.pool.query(`
            DELETE FROM transfers
            WHERE id IN (
                SELECT id FROM (
                    SELECT id, ROW_NUMBER() OVER (
                        PARTITION BY burn_tx_hash
                        ORDER BY updated_at DESC, id DESC
                    ) AS rn
                    FROM transfers
                    WHERE burn_tx_hash IS NOT NULL
                ) duplicates
                WHERE rn > 1
            );
        `);
        await this.pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_burn_tx_hash_unique
            ON transfers(burn_tx_hash)
            WHERE burn_tx_hash IS NOT NULL;
        `);
    }

    async findTransferRow(id) {
        const result = await this.pool.query(
            'SELECT * FROM transfers WHERE id = $1 OR recovery_id = $1 OR burn_tx_hash = $1 LIMIT 1',
            [id],
        );
        return result.rows[0] || null;
    }

    pgValues(record) {
        return TRANSFER_FIELDS.map(field => {
            if (field === 'wallets_json' || field === 'attestation_json' || field === 'metadata_json') {
                return record[field] || null;
            }
            return record[field];
        });
    }

    pgPlaceholder(field, index) {
        const placeholder = `$${index}`;
        return field === 'wallets_json' || field === 'attestation_json' || field === 'metadata_json'
            ? `${placeholder}::jsonb`
            : placeholder;
    }

    async getTransfer(id) {
        return rowToTransfer(await this.findTransferRow(id));
    }

    async upsertTransfer(input) {
        let existing = null;
        for (const lookupKey of lookupKeysFor(input)) {
            existing = await this.findTransferRow(lookupKey);
            if (existing) break;
        }
        const next = normalizeTransfer(input, existing);

        if (existing) {
            const assignments = TRANSFER_FIELDS.filter(field => field !== 'id')
                .map((field, index) => `${field} = ${this.pgPlaceholder(field, index + 1)}`)
                .join(', ');
            const values = TRANSFER_FIELDS.filter(field => field !== 'id').map(field => this.pgValues(next)[TRANSFER_FIELDS.indexOf(field)]);
            values.push(next.id);
            await this.pool.query(`UPDATE transfers SET ${assignments} WHERE id = $${values.length}`, values);
        } else {
            const columns = TRANSFER_FIELDS.join(', ');
            const placeholders = TRANSFER_FIELDS.map((field, index) => this.pgPlaceholder(field, index + 1)).join(', ');
            await this.pool.query(
                `INSERT INTO transfers (${columns}) VALUES (${placeholders})`,
                this.pgValues(next),
            );
        }

        await this.appendTransferEvent(next.id, 'transfer.upserted', input);
        return this.getTransfer(next.id);
    }

    async patchTransfer(id, patch) {
        const existing = await this.findTransferRow(id);
        return this.upsertTransfer({ ...(existing ? rowToTransfer(existing) : { id }), ...patch, id: existing?.id || id });
    }

    async listTransfers({ wallet, limit = 500 } = {}) {
        const safeLimit = clampListLimit(limit);
        const internalLimit = Math.max(safeLimit, 500);
        const result = await this.pool.query('SELECT * FROM transfers ORDER BY updated_at DESC LIMIT $1', [internalLimit]);
        return sortTransferList(filterTransfersByWallet(result.rows.map(rowToTransfer), wallet)).slice(0, safeLimit);
    }

    async listTransfersForWorker() {
        const result = await this.pool.query(`
            SELECT * FROM transfers
            WHERE burn_tx_hash IS NOT NULL
              AND (
                state IN ('burn_submitted', 'attestation_pending', 'recoverable')
                OR (use_forwarder = TRUE AND mint_tx_hash IS NULL AND state NOT IN ('failed', 'already_claimed'))
                OR (already_minted = TRUE AND state <> 'already_claimed')
              )
            ORDER BY updated_at ASC
            LIMIT 100
        `);
        return result.rows.map(rowToTransfer);
    }

    async appendTransferEvent(transferId, eventType, payload = {}) {
        if (!transferId || !eventType) return;
        const safePayload = safeJsonValue(payload);
        await this.pool.query(
            `INSERT INTO transfer_events (transfer_id, event_type, payload_json, created_at)
             VALUES ($1, $2, $3::jsonb, $4)`,
            [transferId, eventType, JSON.stringify(safePayload), nowIso()],
        );
    }

    async backfillTransferContextsFromEvents() {
        const result = await this.pool.query(`
            SELECT * FROM transfers
            WHERE (
                from_chain IS NULL
                OR to_chain IS NULL
                OR source_wallet IS NULL
                OR CASE
                     WHEN jsonb_typeof(wallets_json) = 'array' THEN jsonb_array_length(wallets_json) = 0
                     ELSE TRUE
                   END
                OR state = 'created'
            )
              AND (
                state = 'created'
                OR COALESCE(metadata_json->>'backfilledFromEvents', 'false') <> 'true'
              )
            ORDER BY created_at DESC
            LIMIT 100
        `);
        for (const row of result.rows) {
            const transfer = rowToTransfer(row);
            const events = await this.pool.query(
                'SELECT * FROM transfer_events WHERE transfer_id = $1 ORDER BY created_at ASC',
                [transfer.id],
            );
            const patch = extractTransferPatchFromEvents(transfer, events.rows);
            if (patch) await this.patchTransfer(transfer.id, patch);
        }
    }

    async getSupportBundle(id) {
        const transfer = await this.getTransfer(id);
        if (!transfer) return null;
        const result = await this.pool.query(
            'SELECT * FROM transfer_events WHERE transfer_id = $1 ORDER BY created_at ASC',
            [transfer.id],
        );
        const events = result.rows.map(event => ({
            id: event.id,
            type: event.event_type,
            payload: safeParse(event.payload_json, {}),
            createdAt: event.created_at,
        }));
        return { transfer, events, generatedAt: nowIso() };
    }
}

function getPostgresSslConfig(connectionString) {
    const sslMode = String(process.env.PGSSLMODE || '').toLowerCase();
    if (sslMode === 'disable') return false;
    if (sslMode === 'require' || sslMode === 'no-verify') return { rejectUnauthorized: false };
    if (/localhost|127\.0\.0\.1/.test(connectionString)) return false;
    return { rejectUnauthorized: false };
}

async function createStore() {
    return postgresUrl ? PostgresStore.create() : SqliteStore.create();
}

export const store = await createStore();
