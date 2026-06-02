# QuantumBridge Launch Kit

Use this file for release posts, short bios, demo captions, and launch threads.

Production app:

```text
https://quantum-bridge.onrender.com
```

Repository:

```text
https://github.com/ShalyX/QuantumBridge
```

X account assets:

```text
Profile image: public/social/quantumbridge-profile.png
Header banner: public/social/quantumbridge-x-banner.png
```

## Main Release Post

```text
QuantumBridge v0.1.0 is live.

I started QuantumBridge with a simple idea:

what if moving USDC across chains felt less like waiting on infrastructure, and more like teleportation?

That is where the name came from. A bridge, but with a quantum feel: source chain, destination chain, transfer state, recovery, and activity all wrapped into one experience.

v0.1.0 is the first release of that idea as a working testnet product.

It supports USDC transfers across:

- Arc Testnet
- Solana Devnet
- Ethereum Sepolia

Powered by Circle CCTP.

This release focuses on reliability:

- route-aware bridging
- durable transfer history
- global activity feed
- recovery-first resume
- Circle attestation tracking
- clear product error messages
- wallet support guardrails

The most important part:

If a transfer burns on the source chain but the destination mint gets interrupted, QuantumBridge saves the checkpoint and lets you resume the transfer instead of losing the flow.

Supported Solana wallets for CCTP routes:

- Backpack
- Solflare

Phantom is currently marked limited while its Solana CCTP signature flow remains unstable.

This is still testnet, but it finally feels like the product I imagined:
not just bridging, but teleporting value across networks.

Try QuantumBridge:
https://quantum-bridge.onrender.com
```

## Short X Post

```text
QuantumBridge v0.1.0 is live.

A testnet USDC bridge for Arc Testnet, Solana Devnet, and Ethereum Sepolia, powered by Circle CCTP.

Bridge, track, and resume transfers from one place.

If a destination mint gets interrupted, the burn is saved and recoverable.

Try it:
https://quantum-bridge.onrender.com
```

## Launch Thread Skeleton

```text
1/ QuantumBridge v0.1.0 is live.

I wanted cross-chain USDC movement to feel less like waiting on rails and more like teleportation.

That is the idea behind QuantumBridge.

2/ The app supports testnet USDC transfers across:

- Arc Testnet
- Solana Devnet
- Ethereum Sepolia

Powered by Circle CCTP.

3/ The focus of this release is reliability.

Every transfer gets a durable lifecycle:

created -> burn submitted -> attestation pending -> mint submitted -> completed, recoverable, already claimed, or failed.

4/ The key feature is recovery.

If the source burn succeeds but the destination mint fails, gets interrupted, or the page refreshes, QuantumBridge saves the checkpoint.

You can resume the transfer later.

5/ There is also a global activity feed.

Transfers now show:

- From
- To
- Deposit transaction
- Fill transaction
- Status
- Fill time

6/ Current Solana wallet support:

Backpack: supported
Solflare: supported
Phantom: limited for current Solana CCTP routes

7/ This is still testnet, but it is no longer just a demo.

It is a bridge experience with memory, recovery, and clear transfer state.

Try QuantumBridge:
https://quantum-bridge.onrender.com
```

## Screenshot Captions

Home:

```text
QuantumBridge home: route-aware USDC teleportation across Arc, Solana, and Ethereum testnets.
```

Bridge:

```text
The bridge form keeps the route, destination wallet, live route health, and transfer status in one workspace.
```

Activity:

```text
The Activity Portal shows a Relay-style transfer ledger with source, destination, deposit, fill, status, and fill time.
```

Recovery:

```text
Recovery is a normal resume flow: paste a burn transaction or reconnect wallets to continue pending transfers.
```

Wallet modal:

```text
Wallet guardrails are explicit: Backpack and Solflare are supported for Solana CCTP routes; Phantom is currently limited.
```

## Bio Lines

```text
Recovery-first USDC bridge for Arc, Solana, and Ethereum testnets.
```

```text
Teleport USDC across testnet chains with durable history and route-aware recovery.
```

```text
USDC bridging with memory, powered by Circle CCTP.
```

## Demo Talking Points

- Start on Home and explain the teleportation metaphor.
- Open Bridge and show source/destination route selection.
- Mention that destination wallet paste support exists for custom recipients.
- Show the live time estimate as a route/network-health estimate, not a countdown.
- Collapse or expand Teleportation Status to show the operational log.
- Open Activity and point out the global transfer ledger.
- Open Recovery and explain what happens if a burn succeeds before a destination mint fails.
- Open the wallet modal and explain Backpack/Solflare support and Phantom limits.

## Known Limits To Mention

- v0.1.0 is testnet-only.
- Solana destination routes require a Solana wallet signature because Circle Forwarder is enabled only for EVM destinations in this app.
- Circle Forwarder fees are dynamic; very small forwarded transfers can be blocked before wallet signing if the route fee exceeds the transfer amount.
- Phantom is marked limited for current Solana CCTP routes.
- Render Free can sleep, so the worker may pause until the service wakes.

## Launch Checklist

- Confirm `/api/health` returns `ok: true`.
- Confirm `npm run build` passes.
- Confirm the latest commit is pushed to GitHub.
- Capture dark mode screenshots first.
- Capture one light mode screenshot.
- Test one Backpack or Solflare Solana source route.
- Test one EVM source route.
- Confirm Activity shows the transfer in My Transfers and Global Feed.
- Confirm Recovery can handle already claimed or pending burns with product messages.
