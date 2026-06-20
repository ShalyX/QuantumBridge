# QuantumBridge

QuantumBridge is a CCTP-powered USDC bridge for Arc Testnet, Solana Devnet, and Ethereum Sepolia. It uses Circle App Kit in the browser, a small Node API for durable transfer history, and Postgres on Render for recovery-safe transfer state.

## Launch Notes: v0.1.0

Production app:

```text
https://quantum-bridge.onrender.com
```

Supported routes:

| Route | Status | Notes |
| --- | --- | --- |
| Solana Devnet -> Arc Testnet | Supported | Use Backpack or Solflare. Circle Forwarder completes the Arc mint. |
| Arc Testnet -> Solana Devnet | Supported | Circle Forwarder completes the Solana mint with recipient setup when needed. |
| Ethereum Sepolia -> Arc Testnet | Supported | Circle Forwarder route. |
| Arc Testnet -> Ethereum Sepolia | Supported | Circle Forwarder route. |
| Ethereum Sepolia -> Solana Devnet | Supported | Circle Forwarder completes the Solana mint with recipient setup when needed. |
| Solana Devnet -> Ethereum Sepolia | Supported | Use Backpack or Solflare. Circle Forwarder completes the EVM mint. |

Wallet support:

| Wallet | Status |
| --- | --- |
| Backpack | Supported for Solana CCTP routes |
| Solflare | Supported for Solana CCTP routes |
| Phantom | Locked for Solana CCTP routes pending SDK/wallet compatibility review |
| Rabby | Supported for EVM routes |
| Zerion | Supported where the browser exposes the needed EVM provider |

Recovery behavior:

- Every transfer is written to the backend lifecycle store.
- If a burn succeeds but minting does not finish, the app shows a normal Resume transfer experience after reconnect or refresh.
- Activity cards show route, amount, burn transaction, destination, lifecycle status, and Resume transfer when action is needed.
- The backend worker polls Circle Iris and moves transfers through attestation pending, recoverable, completed, or already claimed states.
- Failed transfer states are captured in backend events and Render logs for support bundles.

Known limits:

- This is testnet-only for v0.1.0.
- Circle Forwarder fees are dynamic by route. Very small forwarded transfers can be below the current route fee and will be blocked before wallet signing.
- Circle Forwarder is enabled for every supported destination, including Solana destination routes. Recovery remains available if a burn succeeds before delivery completes.
- Render Free runs the Iris polling worker inside the web service. Polling pauses if the service sleeps.
- Phantom is visible but locked for Solana CCTP routes while its signing behavior is being reviewed.
- Browser wallet availability depends on each browser extension exposing the expected provider.
- Live time estimates are estimates based on route and current RPC/network health; they are not countdown timers.

## Development

```bash
npm install
npm run api
npm run dev
```

Production build:

```bash
npm run build
```

Health check:

```text
/api/health
```

## Testing

```bash
npm test          # lifecycle, worker, form, and API integration tests
npm run build     # production bundle
npm run test:e2e # Chromium product smoke tests
```

`npm run test:release` runs the complete local release gate. GitHub Actions runs the same checks on every pull request and every push to `main`.

Live wallets and public testnet RPCs are intentionally excluded from CI. Record those checks using [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) before publishing a release.

Brand and launch materials:

- `docs/brand-kit.md`
- `docs/launch-kit.md`
