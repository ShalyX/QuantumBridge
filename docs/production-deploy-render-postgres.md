# Production Deploy: Render + Neon Postgres

QuantumBridge is configured for a production topology with:

- one Render web service for the frontend, API, and Circle Iris polling
- one external Neon Postgres database for durable transfer history

The app uses Postgres whenever `DATABASE_URL` is set. Without `DATABASE_URL`, it falls back to local SQLite for development.

## Files

- `render.yaml` provisions the Render web service and expects `DATABASE_URL` as a secret environment variable.
- `server/store.js` selects Postgres or SQLite and runs schema bootstrap automatically.
- `server/index.js` serves `/api/*` and the built Vite frontend from `dist/`.
- `server/index.js` also starts the Iris polling worker unless `QUANTUM_WORKER_DISABLED=1`.
- `server/worker.js` is available if you later move polling to a paid standalone worker service.

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
3. Create a Neon Postgres project and copy the pooled production connection string.
4. Open:

```text
https://dashboard.render.com/blueprint/new
```

5. Select the repo and apply the Blueprint.
6. Render will provision `quantum-bridge`.
7. In the Render service environment, set:

```
DATABASE_URL=<your Neon pooled connection string>
PGSSLMODE=require
IRIS_API=https://iris-api-sandbox.circle.com
```

Do not commit `DATABASE_URL` to the repo. Neon requires SSL, so keep `PGSSLMODE=require`.

## Migrate Existing Render Postgres History To Neon

If the app previously used Render Postgres, migrate before the Render database expires.

1. In Render, open the old `quantum-bridge-postgres` database.
2. Copy its external connection string.
3. In Neon, copy the production pooled connection string.
4. Run from this repo in PowerShell:

```powershell
$env:SOURCE_DATABASE_URL="<old Render Postgres external URL>"
$env:TARGET_DATABASE_URL="<new Neon pooled connection string>"
npm run migrate:postgres
Remove-Item Env:SOURCE_DATABASE_URL
Remove-Item Env:TARGET_DATABASE_URL
```

The migration merges by transfer id or burn transaction hash. It keeps newer Neon rows when a record already exists, and it skips duplicate transfer events if you run the command more than once.

## Health Check

After deploy:

```text
https://<your-render-service>.onrender.com/api/health
```

Expected:

```json
{
  "ok": true,
  "version": "0.1.0",
  "database": "postgres",
  "worker": "enabled"
}
```

## Production Notes

- Render Free does not support standalone background worker services, so the Blueprint runs Iris polling inside the web service with `QUANTUM_WORKER_DISABLED=0`.
- On a paid plan, you can split polling into a standalone worker by adding a worker service that runs `npm run worker`, then setting `QUANTUM_WORKER_DISABLED=1` on the web service.
- Transfer history is not stored in browser storage; reconnecting a wallet reloads history from Postgres through `/api/transfers?wallet=...`.
- `CORS_ORIGIN` is locked to `https://quantum-bridge.onrender.com` in the Blueprint because the web service serves the frontend and API from the same origin. Use a comma-separated allowlist if you add a custom production domain.
