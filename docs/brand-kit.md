# QuantumBridge Brand Kit

QuantumBridge is a testnet USDC bridge that makes cross-chain value movement feel like teleportation: source chain, quantum tunnel, destination chain, recovery if the jump is interrupted.

## Brand Positioning

One-line description:

```text
QuantumBridge is a recovery-first USDC bridge for Arc Testnet, Solana Devnet, and Ethereum Sepolia, powered by Circle CCTP.
```

Short positioning:

```text
Move USDC across testnet chains with route-aware recovery, durable transfer history, and a global activity feed.
```

Core promise:

```text
Bridge, track, and resume USDC transfers without losing the flow after a refresh, wallet issue, or interrupted destination mint.
```

## Brand Story

The product started from a simple feeling: moving USDC across chains should feel less like waiting on infrastructure and more like teleporting value.

That is why the product language uses:

- teleportation
- quantum tunnel
- fleet connection
- source node
- destination node
- resume transfer
- activity portal

Use the teleportation metaphor to make the product memorable, but keep operational states clear. A user should always know what happened on-chain and what they need to do next.

## Visual Identity

Primary dark background:

```text
Deep space: #05060f
Panel glass: rgba(15, 17, 34, 0.7)
Panel border: rgba(255, 255, 255, 0.1)
```

Primary light background:

```text
Light field: #f1f5f9
Light panel: rgba(255, 255, 255, 0.85)
Light text: #1e1b4b
```

Accent colors:

```text
Quantum violet: #7c3aed
Bridge cyan: #06b6d4
Light-mode cyan: #0891b2
Success green: #10b981
Error red: #ef4444
Secondary text: #94a3b8
Muted text: #64748b
```

Gradient:

```text
linear-gradient(135deg, #7c3aed, #06b6d4)
```

Use the violet-to-cyan gradient for primary actions, active tabs, and brand emphasis. Avoid using it for every card or label.

## Typography

UI font:

```text
Inter
```

Mono font:

```text
JetBrains Mono
```

Use Inter for product copy and interface labels. Use JetBrains Mono for hashes, logs, transfer IDs, and operational telemetry.

## Logo And Marks

Current app sources:

- Standalone mark: `public/quantumbridge-mark.svg`
- Standalone app icon/badge: `public/quantumbridge-icon.svg`
- Standalone horizontal lockup for dark surfaces: `public/quantumbridge-logo.svg`
- Standalone horizontal lockup for light surfaces: `public/quantumbridge-logo-light.svg`
- Header mark: `public/quantumbridge-mark.svg`
- Favicon: `public/favicon.svg` and `public/quantumbridge-icon.svg`
- Shared icon sheet: `public/icons.svg`
- Arc route icon: `src/assets/arc-logo.svg`
- X/social profile PNG: `public/social/quantumbridge-profile.png`
- X/social banner PNG: `public/social/quantumbridge-x-banner.png`

Logo usage:

- Preferred lockup: `QuantumBridge`, with `Quantum` in primary text and `Bridge` in cyan.
- Keep the dotted quantum mark to the left of the wordmark.
- Leave enough space around the lockup so it does not compete with wallet controls or navigation.
- On dark surfaces, use white text plus cyan `Bridge`.
- On light surfaces, use indigo text plus cyan `Bridge`.

Do not:

- Stretch the mark.
- Put the wordmark in a generic blue-only palette.
- Use the teleportation language without also showing concrete transfer/recovery status.

## Product Voice

Voice:

- futuristic but practical
- confident but testnet-honest
- builder-led
- recovery-first
- clear about wallet limits

Write like:

```text
Your burn is saved. Open Recovery and resume this transfer with Backpack or Solflare.
```

Avoid:

```text
Fatal adapter exception.
Unknown blockchain error.
The system encountered a quantum anomaly.
```

## Product Vocabulary

Preferred terms:

| Use | Meaning |
| --- | --- |
| Teleport USDC | Primary bridge action |
| Source node | Origin chain |
| Destination node | Destination chain |
| Teleportation Status | Live transfer log |
| Activity Portal | Transfer history |
| Resume transfer | Recovery action |
| Recovery checkpoint | Saved post-burn state |
| Global Feed | Public transfer activity |

Use plain terms for risky moments:

| State | Product copy |
| --- | --- |
| Burn already claimed | This burn was already claimed. |
| Attestation pending | Circle attestation is not ready yet. |
| Wallet unsupported | Connect Backpack or Solflare to complete this route. |
| Forwarder fee too high | This transfer is below the current Circle Forwarder fee for this route. |
| Destination mint interrupted | Your burn is saved. Open Recovery and resume this transfer. |

## Screenshot Guidance

Capture these screens for launch material:

1. Home tab in dark mode showing the QuantumBridge hero and route cards.
2. Bridge tab with connected wallets, route selected, and live status collapsed.
3. Activity tab showing the ledger view with From, To, Transactions, Status, and Fill Time.
4. Recovery tab showing a pending or already claimed transfer.
5. Wallet modal showing Backpack and Solflare supported, Phantom limited.
6. Light mode home tab for contrast.

Use dark mode as the default launch visual. Use light mode as a secondary product-polish image.

## Social Media Assets

Use these for the QuantumBridge X account:

```text
Profile image: public/social/quantumbridge-profile.png
Header banner: public/social/quantumbridge-x-banner.png
```

The profile image is intentionally icon-only because X crops avatars into a circle. The banner keeps the main wordmark away from the left-bottom avatar overlay area.

## Brand Taglines

Primary:

```text
Teleport USDC across testnet chains.
```

Product:

```text
Bridge, track, and resume USDC transfers across Arc, Solana, and Ethereum testnets.
```

Reliability:

```text
If the mint is interrupted, the transfer is not lost. Resume it.
```

Builder-story:

```text
A bridge built around the feeling of teleportation.
```

Short:

```text
USDC bridging with memory.
```
