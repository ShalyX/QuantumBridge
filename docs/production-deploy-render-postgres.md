# Production Deploy: Render + Postgres

QuantumBridge is configured for a production topology with:

- one Render web service for the frontend and API
- one Render worker service for Circle Iris polling
- one managed Postgres database for durable transfer history

The app uses Postgres whenever `DATABASE_URL` is set. Without `DATABASE_URL`, it falls back to local SQLite for development.

## Files

- `render.yaml` provisions the Render web service, worker service, and Postgres database.
- `server/store.js` selects Postgres or SQLite and runs schema bootstrap automatically.
- `server/index.js` serves `/api/*` and the built Vite frontend from `dist/`.
- `server/worker.js` runs the Iris polling worker without exposing HTTP.

## Local Development

```bash
npm install
npm run api
npm run dev
```

Local API defaults to SQLite at `data/quantum-bridge.sqlite`.

To test local Postgres instead:

```bash
$env:DATABASE_URL="postgres://user:password@localhost:5432/quantumbridge"
$env:PGSSLMODE="disable"
npm run api
```

## Render Blueprint Deploy

1. Push this repo to GitHub, GitLab, or Bitbucket.
2. Confirm `render.yaml` is committed.
3. Open:

```text
https://dashboard.render.com/blueprint/new
```

4. Select the repo and apply the Blueprint.
5. Render will provision:
   - `quantum-bridge`
   - `quantum-bridge-worker`
   - `quantum-bridge-postgres`

## If You Prefer Neon Postgres

Create a Neon database, then replace the Render database binding with a `DATABASE_URL` secret on both Render services.

Keep the same services:

- `quantum-bridge`
- `quantum-bridge-worker`

Set:

```text
DATABASE_URL=<your Neon pooled connection string>
IRIS_API=https://iris-api-sandbox.circle.com
```

Neon requires SSL. Remove the `PGSSLMODE=disable` env var from both Render services when using Neon so the app enables SSL automatically.

## Health Check

After deploy:

```text
https://<your-render-service>.onrender.com/api/health
```

Expected:

```json
{
  "ok": true,
  "database": "postgres"
}
```

## Production Notes

- The web service disables its internal worker with `QUANTUM_WORKER_DISABLED=1`.
- The worker service is the only process polling Circle Iris.
- Transfer history is not stored in browser storage; reconnecting a wallet reloads history from Postgres through `/api/transfers?wallet=...`.
- `CORS_ORIGIN` is set to `*` in the Blueprint because the web service serves the frontend and API from the same origin. Tighten it if you later host the frontend elsewhere.
