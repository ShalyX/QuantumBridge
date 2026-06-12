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

Production deploys should run the Render/Postgres topology in `render.yaml`: one web service with embedded Iris polling and one managed Postgres database on Render Free. See `docs/production-deploy-render-postgres.md`.

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
| Solana Devnet -> Arc Testnet | Phantom | Rabby or Zerion | Chrome / Edge | Limited test path; capture SDK errors and recovery behavior |
| Arc Testnet -> Solana Devnet | Rabby or Zerion | Backpack or Solflare or pasted Solana recipient | Chrome / Edge | Manual mint/resume by default; experimental Circle Forwarder with `?solanaForwarder=1` |
| Ethereum Sepolia -> Arc Testnet | Rabby or Zerion | Rabby or Zerion | Chrome / Edge | Supported with Circle Forwarder |
| Arc Testnet -> Ethereum Sepolia | Rabby or Zerion | Rabby or Zerion | Chrome / Edge | Supported with Circle Forwarder |
| Ethereum Sepolia -> Solana Devnet | Rabby or Zerion | Backpack or Solflare or pasted Solana recipient | Chrome / Edge | Manual mint/resume by default; experimental Circle Forwarder with `?solanaForwarder=1` |

Circle Forwarder is enabled by default when the destination is `arc` or `ethereum`. Solana destination Forwarder is an opt-in experiment via `VITE_EXPERIMENTAL_SOLANA_FORWARDER=1` or `?solanaForwarder=1`; keep manual Solana recovery enabled while validating this route.

## Manual Product Checks

- Start with a clean profile or cleared app storage and connect one EVM wallet plus one Solana wallet.
- Submit a Solana -> Arc transfer with Backpack and confirm the activity card shows route, amount, burn transaction, and lifecycle status.
- Refresh after burn and before mint; confirm the banner says a transfer is ready to resume.
- Click `Resume all`; confirm completed or already claimed transfers leave the pending banner and show a success activity card.
- Paste a known burn transaction into `Resume Transfers`; confirm route, attestation, and destination mint messaging stays product-facing.
- Attempt Solana source transfer with Phantom; confirm the UI allows the test path, logs the Phantom test notice, and saves recovery if signing fails.
- Confirm the live time estimate updates from route/network health probes and does not count down.
- Confirm failed bridge and recovery attempts create `transfer.failed` or `transfer.failure_captured` events in the support bundle and produce a Render log entry.
- Try a tiny Solana Devnet -> Ethereum Sepolia transfer below the current Circle Forwarder fee and confirm the app blocks before wallet signing with a product message.
- Test Arc Testnet -> Solana Devnet once with `?solanaForwarder=1`; confirm the UI says `Experimental Solana Forwarder` and the fee line mentions Solana recipient setup.

## Product Error Messages

Use user-facing messages for expected bridge states:

- Already claimed: `This burn was already claimed.`
- Attestation pending: `Circle attestation is not ready yet.`
- Phantom test failure: `Phantom could not complete this signing flow. If a burn succeeded, open Recovery and resume with any supported Solana wallet.`
- Forwarder fee exceeds amount: `This transfer is below the current Circle Forwarder fee for this route. Increase the amount and try again.`
- Wallet cancellation: `Wallet approval was cancelled.`

Raw SDK errors belong in the browser console only.
