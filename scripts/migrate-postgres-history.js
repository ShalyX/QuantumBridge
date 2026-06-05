import pg from 'pg';

const { Pool } = pg;

const sourceUrl = process.env.SOURCE_DATABASE_URL || '';
const targetUrl = process.env.TARGET_DATABASE_URL || process.env.DATABASE_URL || '';

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

const JSON_FIELDS = new Set(['wallets_json', 'attestation_json', 'metadata_json']);

function assertEnv() {
    if (!sourceUrl || !targetUrl) {
        console.error([
            'Missing database URLs.',
            '',
            'Set these environment variables, then run again:',
            '  SOURCE_DATABASE_URL=<old Render Postgres external URL>',
            '  TARGET_DATABASE_URL=<new Neon pooled connection string>',
        ].join('\n'));
        process.exit(1);
    }

    if (sourceUrl === targetUrl) {
        console.error('SOURCE_DATABASE_URL and TARGET_DATABASE_URL are the same. Aborting.');
        process.exit(1);
    }
}

function sslConfig(connectionString, mode = '') {
    const sslMode = mode.toLowerCase();
    if (sslMode === 'disable') return false;
    if (sslMode === 'require' || sslMode === 'no-verify') return { rejectUnauthorized: false };
    if (/localhost|127\.0\.0\.1/.test(connectionString)) return false;
    return { rejectUnauthorized: false };
}

function createPool(connectionString, mode = '') {
    return new Pool({
        connectionString,
        ssl: sslConfig(connectionString, mode),
        connectionTimeoutMillis: 15000,
        idleTimeoutMillis: 10000,
        max: 3,
    });
}

function stableStringify(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function jsonValue(value) {
    if (value === undefined || value === null) return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function eventFingerprint(event, transferId = event.transfer_id) {
    return [
        transferId,
        event.event_type,
        new Date(event.created_at).toISOString(),
        stableStringify(event.payload_json),
    ].join('|');
}

function fieldValue(row, field, id = row.id) {
    if (field === 'id') return id;
    if (JSON_FIELDS.has(field)) return jsonValue(row[field]);
    return row[field] ?? null;
}

function placeholder(field, index) {
    return JSON_FIELDS.has(field) ? `$${index}::jsonb` : `$${index}`;
}

function asTime(value) {
    if (!value) return 0;
    return new Date(value).getTime() || 0;
}

async function ensureSchema(client) {
    await client.query(`
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

        CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_burn_tx_hash_unique
        ON transfers(burn_tx_hash)
        WHERE burn_tx_hash IS NOT NULL;
    `);
}

async function findTargetTransfer(client, sourceRow) {
    if (sourceRow.burn_tx_hash) {
        const result = await client.query(
            `SELECT * FROM transfers
             WHERE id = $1 OR burn_tx_hash = $2
             ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END
             LIMIT 1`,
            [sourceRow.id, sourceRow.burn_tx_hash],
        );
        return result.rows[0] || null;
    }

    const result = await client.query('SELECT * FROM transfers WHERE id = $1 LIMIT 1', [sourceRow.id]);
    return result.rows[0] || null;
}

async function insertTransfer(client, row) {
    const columns = TRANSFER_FIELDS.join(', ');
    const placeholders = TRANSFER_FIELDS.map((field, index) => placeholder(field, index + 1)).join(', ');
    const values = TRANSFER_FIELDS.map(field => fieldValue(row, field));
    await client.query(`INSERT INTO transfers (${columns}) VALUES (${placeholders})`, values);
}

async function updateTransfer(client, targetId, sourceRow) {
    const fields = TRANSFER_FIELDS.filter(field => field !== 'id');
    const assignments = fields.map((field, index) => `${field} = ${placeholder(field, index + 1)}`).join(', ');
    const values = fields.map(field => fieldValue(sourceRow, field, targetId));
    values.push(targetId);
    await client.query(`UPDATE transfers SET ${assignments} WHERE id = $${values.length}`, values);
}

async function migrateTransfers(source, target) {
    console.log('Reading source transfers...');
    const result = await source.query('SELECT * FROM transfers ORDER BY created_at ASC, id ASC');
    console.log(`Found ${result.rowCount} source transfers.`);
    const idMap = new Map();
    const stats = { inserted: 0, updated: 0, skipped: 0 };

    for (const row of result.rows) {
        const existing = await findTargetTransfer(target, row);

        if (!existing) {
            await insertTransfer(target, row);
            idMap.set(row.id, row.id);
            stats.inserted += 1;
            continue;
        }

        idMap.set(row.id, existing.id);

        if (asTime(row.updated_at) > asTime(existing.updated_at)) {
            await updateTransfer(target, existing.id, row);
            stats.updated += 1;
        } else {
            stats.skipped += 1;
        }
    }

    return { idMap, stats, total: result.rowCount };
}

async function migrateEvents(source, target, idMap) {
    console.log('Reading source transfer events...');
    const result = await source.query('SELECT * FROM transfer_events ORDER BY id ASC');
    console.log(`Found ${result.rowCount} source transfer events.`);
    const stats = { inserted: 0, skipped: 0, missingTransfer: 0 };
    const transferIds = [...new Set(result.rows.map(event => idMap.get(event.transfer_id) || event.transfer_id))];
    const existingTransfers = transferIds.length
        ? await target.query('SELECT id FROM transfers WHERE id = ANY($1::text[])', [transferIds])
        : { rows: [] };
    const existingTransferIds = new Set(existingTransfers.rows.map(row => row.id));
    const existingEvents = transferIds.length
        ? await target.query(
            `SELECT transfer_id, event_type, payload_json, created_at
             FROM transfer_events
             WHERE transfer_id = ANY($1::text[])`,
            [transferIds],
        )
        : { rows: [] };
    const existingFingerprints = new Set(existingEvents.rows.map(event => eventFingerprint(event)));
    const pending = [];

    for (const event of result.rows) {
        const transferId = idMap.get(event.transfer_id) || event.transfer_id;
        if (!existingTransferIds.has(transferId)) {
            stats.missingTransfer += 1;
            continue;
        }

        const fingerprint = eventFingerprint(event, transferId);
        if (existingFingerprints.has(fingerprint)) {
            stats.skipped += 1;
            continue;
        }

        existingFingerprints.add(fingerprint);
        pending.push([transferId, event.event_type, jsonValue(event.payload_json), event.created_at]);
        stats.inserted += 1;
    }

    for (let index = 0; index < pending.length; index += 200) {
        const batch = pending.slice(index, index + 200);
        const values = [];
        const placeholders = batch.map((event, eventIndex) => {
            const offset = eventIndex * 4;
            values.push(...event);
            return `($${offset + 1}, $${offset + 2}, $${offset + 3}::jsonb, $${offset + 4})`;
        });
        await target.query(
            `INSERT INTO transfer_events (transfer_id, event_type, payload_json, created_at)
             VALUES ${placeholders.join(', ')}`,
            values,
        );
        console.log(`Inserted event batch ${Math.min(index + batch.length, pending.length)} / ${pending.length}.`);
    }

    return { stats, total: result.rowCount };
}

async function main() {
    assertEnv();

    console.log('Connecting to source Postgres...');
    const source = createPool(sourceUrl, process.env.SOURCE_PGSSLMODE || '');
    source.on('error', error => console.warn(`Source Postgres connection warning: ${error.message}`));
    await source.query('SELECT 1');
    console.log('Source connected.');

    console.log('Connecting to target Postgres...');
    const target = createPool(targetUrl, process.env.TARGET_PGSSLMODE || process.env.PGSSLMODE || 'require');
    target.on('error', error => console.warn(`Target Postgres connection warning: ${error.message}`));
    await target.query('SELECT 1');
    console.log('Target connected.');

    try {
        console.log('Ensuring target schema...');
        await ensureSchema(target);
        const transferResult = await migrateTransfers(source, target);
        const eventResult = await migrateEvents(source, target, transferResult.idMap);

        console.log('QuantumBridge history migration complete.');
        console.log(`Transfers read: ${transferResult.total}`);
        console.log(`Transfers inserted: ${transferResult.stats.inserted}`);
        console.log(`Transfers updated: ${transferResult.stats.updated}`);
        console.log(`Transfers skipped: ${transferResult.stats.skipped}`);
        console.log(`Events read: ${eventResult.total}`);
        console.log(`Events inserted: ${eventResult.stats.inserted}`);
        console.log(`Events skipped: ${eventResult.stats.skipped}`);
        console.log(`Events skipped without transfer: ${eventResult.stats.missingTransfer}`);
    } finally {
        await source.end();
        await target.end();
    }
}

main().catch(error => {
    console.error('QuantumBridge history migration failed.');
    console.error(error);
    process.exit(1);
});
