# QuantumBridge Release Guardrails

QuantumBridge should ship as a recovery-first bridge product, not as a one-shot demo. Every release needs the checks below.

## Transfer Lifecycle

Each bridge attempt is persisted by the backend transfer API. The browser keeps only an in-memory view of transfer history and pending recoveries for the current session.

Valid lifecycle states:

- `created`
- `burn_submitted`
- `attestation_pending`
- `mint_submitted`
- `completed`
- `recoverable`
- `already_claimed`
- `failed`

Legacy browser transfer keys (`quantum_bridge_transfer_lifecycle`, `quantum_bridge_cctp_recoveries`, and `quantum_bridge_activity`) are cleared on startup. Wallet reconnect preference is the only browser-persisted client state.

## Required Checks

Run these before tagging or deploying:

```bash
npm ci
npm run build
npm run api
```

For the single-command local release check:

```bash
npm run verify:clean
```

Use exact dependency versions from `package.json`. The Solana adapter patch in `patches/@circle-fin+adapter-solana-kit+1.4.5.patch` must apply during `postinstall`.

The backend recovery service must be running for durable transfer persistence. See `docs/backend-recovery-service.md`.

Production deploys should run the Render/Postgres topology in `render.yaml`: one web service, one Iris worker, and one managed Postgres database. See `docs/production-deploy-render-postgres.md`.

Run a release security gate:

```bash
npm audit --omit=dev --audit-level=high
```

Current known audit noise is moderate transitive exposure through `@solana/web3.js` and `viem`; do not run `npm audit fix --force` without re-testing the wallet matrix.

## Known-Good Matrix

| Route | Source wallet | Destination wallet | Browser | Status |
| --- | --- | --- | --- | --- |
| Solana Devnet -> Arc Testnet | Backpack | Rabby or Zerion | Chrome / Edge | Supported with Circle Forwarder |
| Solana Devnet -> Arc Testnet | Solflare | Rabby or Zerion | Chrome / Edge | Supported with Circle Forwarder |
| Solana Devnet -> Arc Testnet | Phantom | Rabby or Zerion | Chrome / Edge | Blocked in UI; use Backpack or Solflare |
| Arc Testnet -> Solana Devnet | Rabby or Zerion | Backpack or Solflare | Chrome / Edge | Supported through manual destination mint or resume transfer |
| Ethereum Sepolia -> Arc Testnet | Rabby or Zerion | Rabby or Zerion | Chrome / Edge | Supported with Circle Forwarder |
| Arc Testnet -> Ethereum Sepolia | Rabby or Zerion | Rabby or Zerion | Chrome / Edge | Supported with Circle Forwarder |

Circle Forwarder is enabled only when the destination is `arc` or `ethereum`. Solana is not currently a Forwarding Service destination, so Solana destination routes still require a Solana wallet signature.

## Manual Product Checks

- Start with a clean profile or cleared app storage and connect one EVM wallet plus one Solana wallet.
- Submit a Solana -> Arc transfer with Backpack and confirm the activity card shows route, amount, burn transaction, and lifecycle status.
- Refresh after burn and before mint; confirm the banner says a transfer is ready to resume.
- Click `Resume all`; confirm completed or already claimed transfers leave the pending banner and show a success activity card.
- Paste a known burn transaction into `Resume Transfers`; confirm route, attestation, and destination mint messaging stays product-facing.
- Attempt Solana source transfer with Phantom; confirm the UI asks for Solflare or Backpack instead of exposing raw adapter errors.

## Product Error Messages

Use user-facing messages for expected bridge states:

- Already claimed: `This burn was already claimed.`
- Attestation pending: `Circle attestation is not ready yet.`
- Unsupported Solana wallet for route: `Connect Solflare or Backpack to complete this route.`
- Wallet cancellation: `Wallet approval was cancelled.`

Raw SDK errors belong in the browser console only.
