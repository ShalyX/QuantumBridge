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
        updated_at: timestamp,
        last_checked_at: input.lastCheckedAt || input.last_checked_at || existing?.last_checked_at || null,
    };
}

function rowToTransfer(row) {
    if (!row) return null;
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
        wallets: safeParse(row.wallets_json, []),
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
        const rows = this.db.prepare('SELECT * FROM transfers ORDER BY updated_at DESC LIMIT ?').all(safeLimit);
        return filterTransfersByWallet(rows.map(rowToTransfer), wallet);
    }

    async listTransfersForWorker() {
        const rows = this.db.prepare(`
            SELECT * FROM transfers
            WHERE burn_tx_hash IS NOT NULL
              AND (state IN ('burn_submitted', 'attestation_pending', 'recoverable') OR already_minted = 1)
            ORDER BY updated_at ASC
            LIMIT 100
        `).all();
        return rows.map(rowToTransfer);
    }

    async appendTransferEvent(transferId, eventType, payload = {}) {
        if (!transferId || !eventType) return;
        this.db.prepare(`
            INSERT INTO transfer_events (transfer_id, event_type, payload_json, created_at)
            VALUES (?, ?, ?, ?)
        `).run(transferId, eventType, JSON.stringify(payload), nowIso());
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
                return record[field] ? JSON.parse(record[field]) : null;
            }
            return record[field];
        });
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
                .map((field, index) => `${field} = $${index + 1}`)
                .join(', ');
            const values = TRANSFER_FIELDS.filter(field => field !== 'id').map(field => this.pgValues(next)[TRANSFER_FIELDS.indexOf(field)]);
            values.push(next.id);
            await this.pool.query(`UPDATE transfers SET ${assignments} WHERE id = $${values.length}`, values);
        } else {
            const columns = TRANSFER_FIELDS.join(', ');
            const placeholders = TRANSFER_FIELDS.map((_, index) => `$${index + 1}`).join(', ');
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
        const result = await this.pool.query('SELECT * FROM transfers ORDER BY updated_at DESC LIMIT $1', [safeLimit]);
        return filterTransfersByWallet(result.rows.map(rowToTransfer), wallet);
    }

    async listTransfersForWorker() {
        const result = await this.pool.query(`
            SELECT * FROM transfers
            WHERE burn_tx_hash IS NOT NULL
              AND (state IN ('burn_submitted', 'attestation_pending', 'recoverable') OR already_minted = TRUE)
            ORDER BY updated_at ASC
            LIMIT 100
        `);
        return result.rows.map(rowToTransfer);
    }

    async appendTransferEvent(transferId, eventType, payload = {}) {
        if (!transferId || !eventType) return;
        await this.pool.query(
            `INSERT INTO transfer_events (transfer_id, event_type, payload_json, created_at)
             VALUES ($1, $2, $3, $4)`,
            [transferId, eventType, payload, nowIso()],
        );
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
