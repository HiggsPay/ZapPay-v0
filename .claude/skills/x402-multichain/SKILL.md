# x402 Protocol — Multichain & Multi-Token Reference

This skill documents the x402 v2 protocol's chain, token, and scheme support as researched from official sources (x402.org, github.com/coinbase/x402, docs.cdp.coinbase.com/x402).

Use this skill when: implementing x402 payment acceptance, configuring payment middleware for multiple chains/tokens, looking up contract addresses, or understanding which scheme handles which token type.

---

## Supported Chains

### EVM (`eip155:*`) — via `@x402/evm`

| Network | CAIP-2 | Status |
|---|---|---|
| Base Sepolia | `eip155:84532` | Testnet |
| Base | `eip155:8453` | Mainnet |
| Ethereum | `eip155:1` | Mainnet |
| Polygon | `eip155:137` | Mainnet |
| Arbitrum One | `eip155:42161` | Mainnet |
| Scroll | `eip155:534352` | Mainnet |
| World | `eip155:480` | Mainnet |
| World Sepolia | `eip155:4801` | Testnet |

**Register:** `registerExactEvmScheme(resourceServer)` from `@x402/evm/exact/server`

### Solana (`solana:*`) — via `@x402/solana`

| Network | CAIP-2 | Status |
|---|---|---|
| Mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Mainnet |
| Devnet | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | Testnet |

**Register:** `registerExactSvmScheme(resourceServer)` from `@x402/svm/exact/server`

### Stellar (`stellar:*`) — via `@x402/stellar`

| Network | CAIP-2 | Status |
|---|---|---|
| Pubnet | `stellar:pubnet` | Mainnet |
| Testnet | `stellar:testnet` | Testnet |

**Register:** `new ExactStellarScheme()` + `resourceServer.register("stellar:*", new ExactStellarScheme())` from `@x402/stellar/exact/server`

---

## Token Support by Chain

### EVM Tokens

The `exact` scheme on EVM supports two transfer paths — the client auto-selects:

1. **EIP-3009 path** (`transferWithAuthorization`) — USDC, EURC. Fully gasless.
2. **Permit2 path** — ANY ERC-20 token (incl. USDT which lacks EIP-3009). Uses:
   - Permit2 universal contract: `0x000000000022D473030F116dDEE9F6B43aC78BA3` (all EVM chains)
   - x402ExactPermit2Proxy: `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` (all EVM chains, CREATE2)

**Key fact:** USDT on EVM IS supported via Permit2 — it doesn't need EIP-3009.

#### EVM Contract Addresses

| Chain | Token | Contract Address |
|---|---|---|
| Base Sepolia | USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Base | USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Base | USDT | `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` |
| Ethereum | USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Ethereum | USDT | `0xdAC17F958D2ee523a2206206994597C13D831ec7` |
| Polygon | USDC | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |
| Arbitrum One | USDC | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| Scroll | USDC | `0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4` |
| World | USDC | `0x79A02482A880bCE3F13e09Da970dC34db4CD24d1` |

**To add any other ERC-20:** Provide its contract address as `asset` in the `accepts` entry. Permit2 handles it automatically.

### Solana Tokens

Supports **all SPL tokens** and Token-2022 program tokens. Uses Associated Token Accounts (ATAs).

| Network | Token | Mint Address |
|---|---|---|
| Mainnet | USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Devnet | USDC | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |

**`payTo`** for Solana = merchant's Solana wallet address (base58).

### Stellar Tokens

Supports **any SEP-41 compliant token** via Soroban authorization.

| Network | Token | Asset |
|---|---|---|
| Pubnet | USDC | `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` |
| Testnet | USDC | `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |

**`payTo`** for Stellar = merchant's Stellar public key (G...).

---

## Scheme Summary

| Chain | Scheme | Token Scope |
|---|---|---|
| EVM | `exact` (EIP-3009 + Permit2) | USDC, EURC natively; any ERC-20 via Permit2 |
| Solana | `exact` (SPL transfer) | All SPL tokens + Token-2022 |
| Stellar | `exact` (Soroban auth + fee bump) | Any SEP-41 token |

All chains use `scheme: "exact"`. The underlying mechanism differs per chain family but the x402 API surface is uniform.

---

## x402 Server Setup (multichain)

```typescript
import { x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";

const facilitatorClient = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
const resourceServer = new x402ResourceServer(facilitatorClient);

// Register all scheme handlers
registerExactEvmScheme(resourceServer);
registerExactSvmScheme(resourceServer);
resourceServer.register("stellar:*", new ExactStellarScheme());
```

> Stellar uses the class-based API (`resourceServer.register`) rather than a `registerExact*` helper function — different from EVM and SVM.

### Dynamic multi-chain `accepts` array example

```typescript
// Accept USDC on Base + USDT on Base + USDC on Solana mainnet
const accepts = [
  {
    scheme: "exact",
    price: "$1.00",
    network: "eip155:8453",          // Base
    payTo: "0xYourEvmAddress",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  // USDC
  },
  {
    scheme: "exact",
    price: "$1.00",
    network: "eip155:8453",          // Base
    payTo: "0xYourEvmAddress",
    asset: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",  // USDT (Permit2)
  },
  {
    scheme: "exact",
    price: "$1.00",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",  // Solana mainnet
    payTo: "YourSolanaWalletBase58Address",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // USDC SPL
  },
];
```

---

## payTo Address by Chain Family

Each chain family requires the merchant's wallet address in that chain's format:

| Chain Family | Address Format | Example |
|---|---|---|
| EVM (all) | `0x` + 40 hex chars | `0x7cAc6ECaA934999ad40a9666d017f186788CDe6E` |
| Solana | Base58 public key | `DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy` |
| Stellar | G... public key | `GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKF9GFJKJ3MHKB7EAF6CA` |

One EVM address works for **all EVM chains** — a merchant needs at most 3 addresses for full EVM+Solana+Stellar coverage.

---

## npm Package Names (x402 v2)

```bash
npm install @x402/core @x402/hono @x402/evm @x402/axios
npm install @x402/svm        # for Solana/SVM support
npm install @x402/stellar    # for Stellar support
```

All packages are published on npm (no local vendoring). Install with standard `npm install`.

---

## Import Paths

### Server-side (`/exact/server`)

```typescript
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { ExactStellarScheme }     from "@x402/stellar/exact/server";
```

### Client-side (`/exact/client`)

```typescript
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { ExactStellarScheme }     from "@x402/stellar/exact/client";
```

**Important:** `@x402/stellar/exact/client` exports `ExactStellarScheme` (class), NOT a `registerExact*` function. Registration on the client uses the same class-based API as the server:

```typescript
// EVM and SVM use registerExact* helpers:
registerExactEvmScheme(client, { signer: evmSigner });
registerExactSvmScheme(client, { signer: svmSigner });

// Stellar uses the class directly (both server and client):
client.register("stellar:*", new ExactStellarScheme(stellarSigner));
```

> **Always verify** the exact export paths from each package's `package.json` exports field after installing — these follow the documented pattern but package internals can shift between minor versions.

---

## Facilitator Verification

To confirm which chains/tokens your facilitator instance supports, call:

```
GET https://x402.org/facilitator/supported
```

Cross-reference contract addresses against this response before going to production.

---

## Key Constraints

- **Native ETH not supported**: The `exact` EVM scheme requires EIP-3009 or Permit2 (both ERC-20 standards). Native ETH does not implement either. Use WETH if needed.
- **Price is USD-denominated**: `price: "$1.00"` — the facilitator converts to token amounts.
- **One `accepts` entry per chain+token combo**: Multiple entries in the array let the client pick any one to pay with.
- **`asset` is required for ERC-20**: Omitting `asset` on EVM implies native ETH (unsupported). Always include the contract address.
- **Cache is per-process**: In-memory caches for merchant configs are process-local. Use Redis for multi-instance deployments.
