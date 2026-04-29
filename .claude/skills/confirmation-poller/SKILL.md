# ZapPay — On-Chain Confirmation Poller

Use this skill when: modifying chain support, changing poll intervals, debugging `processing` transactions that aren't moving to `completed`, or adding new chain types.

---

## How It Works

A `setInterval`-based background job starts at server boot. Every 15 seconds it:

1. Queries Supabase for `status = 'processing'` rows with a non-null `tx_hash` and `network`
2. Dispatches each to the correct chain checker (EVM / Solana / Stellar)
3. Upgrades `processing → completed` on confirmed receipt, or `processing → failed` on revert / 30-min stale

A concurrency guard (`inFlight` flag) ensures overlapping cycles never run simultaneously.

## File

`server/services/confirmationPoller.ts`

## Entry Point

```typescript
// Called in server/index.ts just before serve()
const stopPoller = startConfirmationPoller(
  parseInt(process.env.POLL_INTERVAL_MS ?? '15000')
);
process.on('SIGTERM', () => { stopPoller(); process.exit(0); });
process.on('SIGINT',  () => { stopPoller(); process.exit(0); });
```

## Supported Chains & CAIP-2 IDs

### EVM (via viem)

| Chain | CAIP-2 | Env var |
|---|---|---|
| Ethereum | `eip155:1` | `RPC_URL_ETHEREUM` |
| Base | `eip155:8453` | `RPC_URL_BASE` |
| Polygon | `eip155:137` | `RPC_URL_POLYGON` |
| Arbitrum | `eip155:42161` | `RPC_URL_ARBITRUM` |
| Optimism | `eip155:10` | `RPC_URL_OPTIMISM` |
| BSC | `eip155:56` | `RPC_URL_BSC` |

Confirmation method: `client.getTransactionReceipt({ hash })` → `receipt.status === 'success' | 'reverted'`

### Solana (via @solana/web3.js)

| Network | CAIP-2 | Env var |
|---|---|---|
| Mainnet | `solana:mainnet` | `RPC_URL_SOLANA` |
| Devnet | `solana:devnet` | `RPC_URL_SOLANA_DEVNET` |

Confirmation method: `connection.getTransaction(signature)` → `meta.err === null` (success) / non-null (failed) / `null` result = not yet confirmed

### Stellar (via @stellar/stellar-sdk Horizon)

| Network | CAIP-2 | Env var |
|---|---|---|
| Mainnet | `stellar:mainnet` | `RPC_URL_STELLAR` |
| Testnet | `stellar:testnet` | `RPC_URL_STELLAR_TESTNET` |

Confirmation method: `server.transactions().transaction(hash).call()` → `result.successful` / 404 = not yet confirmed

## Environment Variables

```
RPC_URL_ETHEREUM=https://eth.llamarpc.com
RPC_URL_BASE=https://mainnet.base.org
RPC_URL_POLYGON=https://polygon-rpc.com
RPC_URL_ARBITRUM=https://arb1.arbitrum.io/rpc
RPC_URL_OPTIMISM=https://mainnet.optimism.io
RPC_URL_BSC=https://bsc-dataseed.binance.org
RPC_URL_SOLANA=https://api.mainnet-beta.solana.com
RPC_URL_SOLANA_DEVNET=https://api.devnet.solana.com
RPC_URL_STELLAR=https://horizon.stellar.org
RPC_URL_STELLAR_TESTNET=https://horizon-testnet.stellar.org
POLL_INTERVAL_MS=15000
TX_STALE_AFTER_MS=1800000
```

All RPC vars are optional — omitting one falls back to the chain's public default endpoint (rate-limited).

## How tx_hash Gets Onto the Row

The `PAYMENT-RESPONSE` response header (set by `@x402/hono`'s `paymentMiddleware`) contains a base64-encoded `SettleResponse`:

```typescript
type SettleResponse = {
  success: boolean;
  transaction: string;  // the on-chain tx hash
  network: Network;     // CAIP-2 e.g. "eip155:8453"
  payer?: string;       // wallet address
  amount?: string;      // atomic units
}
```

This header is set **after** the route handler exits (in the middleware's post-`next()` phase). A post-settlement interceptor middleware reads it on the way back out:

```typescript
// In server/index.ts — registered AFTER paymentMiddleware
app.use("/api/pay/session",  async (c, next) => { await next(); await captureSettlementData(c); });
app.use("/api/pay/onetime",  async (c, next) => { await next(); await captureSettlementData(c); });
```

`captureSettlementData()` calls `updateTransactionBySessionId()` to patch `tx_hash`, `network`, and `wallet_address` onto the row using `session_id` as the lookup key.

## Adding a New EVM Chain

1. Import the chain from `viem/chains` in `confirmationPoller.ts`
2. Add an entry to `EVM_CHAIN_CONFIG`:
   ```typescript
   'eip155:CHAIN_ID': { chain: viemChain, rpcEnvVar: 'RPC_URL_CHAINNAME' },
   ```
3. Add the env var to `.env.example` and your `.env`

## Stale Transaction Logic

If `getTransactionReceipt` / `getTransaction` throws a "not found" error AND the row is older than `TX_STALE_AFTER_MS` (default 30 min), the transaction is marked `failed`. RPC/network errors (non-404) skip that transaction for the current cycle without marking it failed.

## Required DB Columns

The poller depends on these columns existing in `transactions`. All are first-class columns in the current schema (`server/supabase/supabase-migration.sql`) — no ALTER needed on a fresh DB:

- `tx_hash TEXT` — the on-chain hash (populated by post-settlement interceptor)
- `network TEXT` — CAIP-2 network id (populated by post-settlement interceptor)
- `session_id TEXT` — links the route handler to the DB row
- `wallet_address TEXT` — populated from `SettleResponse.payer`
- `checkout_id UUID` — links to `checkouts.id` when the payment came via a checkout session
- `block_reason TEXT` — set on `blocked` transactions
- `risk_score INT` — set on `blocked` transactions
