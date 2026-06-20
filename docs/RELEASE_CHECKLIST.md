# QuantumBridge Release Checklist

QuantumBridge v0.1.x is testnet software. A release is ready only when the automated gates pass and the live wallet matrix is recorded for the candidate commit.

## Automated gates

- `npm ci` completes from the lockfile.
- `npm test` passes lifecycle, fill-time, form-reset, API persistence, CORS, and Iris worker tests.
- `npm run build` produces the production bundle.
- `npm run test:e2e` passes Chromium navigation, wallet-modal, status-console, theme, and backend-history smoke tests.
- GitHub Actions `Release checks` is green on the release commit.

## Live testnet route matrix

Run a small transfer on every route. Record the burn hash, fill hash, amount, wallet, observed fill time, and result.

| Route | Backpack | Solflare |
| --- | --- | --- |
| Solana Devnet -> Arc Testnet | Required | Required |
| Solana Devnet -> Ethereum Sepolia | Required | Required |
| Arc Testnet -> Solana Devnet | Destination-only check | Destination-only check |
| Ethereum Sepolia -> Solana Devnet | Destination-only check | Destination-only check |

Also run the EVM-only routes with at least Rabby and MetaMask:

- Arc Testnet -> Ethereum Sepolia
- Ethereum Sepolia -> Arc Testnet

Phantom must remain visibly locked for Solana CCTP routes until its signing compatibility test is deliberately re-enabled and passes.

## Failure drills

- Refresh after source burn and confirm Activity restores the transfer.
- Simulate an unavailable transfer API and confirm queued sync retries later.
- Simulate Solana RPC `503` and confirm balance polling backs off without breaking the page.
- Confirm Circle `not indexed` and pending attestations remain non-terminal.
- Resume an already-claimed burn and confirm it becomes `already_claimed` without another mint.
- Reject a wallet request and confirm no burn hash is recorded.
- Attempt an amount below the Forwarder fee and confirm signing is blocked.

## Production smoke checks

- Vercel application loads the current commit.
- Render `/api/health` returns `ok: true`, `database: postgres`, and `worker: enabled`.
- Vercel-origin CORS preflight returns `204` from Render.
- A completed transfer appears in My Transfers and Global Feed after reload.
- Neon contains the transfer and its lifecycle events.
- No secrets, private keys, database URLs, or wallet session data appear in the bundle or browser console.
