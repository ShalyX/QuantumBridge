# Backend Recovery Service

QuantumBridge now has a backend that makes transfer lifecycle records durable outside browser storage.

## Run It

Start the API and worker:

```bash
npm run api
```

Start the frontend in a second terminal:

```bash
npm run dev
```

Vite proxies `/api/*` to `http://localhost:8787` during development. In production, serve the frontend and API from the same origin, or set `VITE_TRANSFER_API_URL`.

## Storage

In local development, the backend stores records in SQLite:

```text
data/quantum-bridge.sqlite
```

`data/` is ignored by git. For production, move this schema to Postgres or another managed database.
`data/` is ignored by git.

In production, set `DATABASE_URL` to use Postgres. The same schema is bootstrapped automatically on startup. See `docs/production-deploy-render-postgres.md`.

## API

Create or upsert a transfer:

```http
POST /api/transfers
```

Patch lifecycle state:

```http
PATCH /api/transfers/:id
```

Load transfers for a connected wallet:

```http
GET /api/transfers?wallet=0x...
GET /api/transfers?wallet=SolanaPublicKey...
```

Append an event:

```http
POST /api/transfers/:id/events
```

Fetch a support bundle:

```http
GET /api/transfers/:id/support-bundle
```

## Worker Behavior

The worker polls Circle Iris every 30 seconds for transfers in:

- `burn_submitted`
- `attestation_pending`
- `recoverable`

State transitions:

- Not indexed or pending attestation -> `attestation_pending`
- Attestation ready, no Forwarder -> `recoverable`
- Forwarder confirmed -> `completed`
- Already claimed flag from a recovery attempt -> `already_claimed`

The worker never signs or submits wallet transactions. Browser wallets still handle manual Solana destination mints.

## Browser State

Transfer history, lifecycle records, and pending recoveries are not persisted in browser storage. The frontend keeps only an in-memory view for the current session and repopulates it from the backend after wallet connect or trusted wallet restore.

The only browser-persisted value is the last selected wallet preference (`quantum_bridge_wallet_session`) so the app can attempt a silent reconnect after refresh. Clicking disconnect clears that preference and the visible in-memory transfer state.
